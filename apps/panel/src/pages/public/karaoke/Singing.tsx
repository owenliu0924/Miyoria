// The singing screen, a karaoke box after the owner's own app: one stage with the song's video (or
// a still) behind everything, the pitch lane across its upper part, two large lyric lines low in
// the middle, the title and the running number (預估) at the top; a quiet bar of controls under
// it. The backing track plays through Web Audio, the microphone goes through the pitch worklet,
// and, when the session allows, is recorded for the official score. Before the start the key can
// be moved (the Core has the worker render the backing in it; the reference moves here by the
// same). There is no pause: the recording is one stretch of the song. At the song's end (or
// 「唱完了」) the track is encoded and handed on with the recording; nothing is sent while singing.

import { ArrowLeft, Check, LogOut, Minus, Play, Plus, RotateCcw, Timer } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { KaraokeSession, KaraokeSongView, KaraokeSubmit } from "@miyoria/contracts/api";
import {
  KARAOKE_MAX_SHIFT,
  karaokeReferenceV2,
  shiftKaraokeReference,
  type WorkersKaraokeReference,
  type WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers/karaoke";
import type { ScoreResult } from "@miyoria/play/karaoke/score";
import { describeError, joinUrl } from "@/api/http";
import { useConnection } from "@/app/connection";
import { ConfirmDialog } from "@/components/confirm";
import { Dot } from "@/components/status";
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { KaraokeEngine } from "./audio";
import { HeadphonesLine, PrivacyLine, Refusal, useReducedMotion } from "./bits";
import { SongClock } from "./clock";
import { LANE_SECONDS, LANE_SECONDS_NARROW, type LaneView, type MidiRange, midiRange } from "./lane";
import { drawLane, type LaneColors, laneColors } from "./lane-draw";
import { noiseFloor } from "./latency";
import { HeardBadge, Lyrics, ReadingToggle } from "./Lyrics";
import { keyLabel, loadKey, loadReading, type ReadingMode, saveKey, saveReading } from "./lyric-text";
import type { RecorderState, VoiceRecorder, VoiceTake } from "./recorder";
import { clock } from "./result-text";
import { StageBackground } from "./StageBackground";
import { browserName } from "./support";
import { finishTake, phrasesOf, referenceCurve, Take } from "./take";

/** What a finished singing hands on: to be sent, and the number shown until Core answers. */
export interface Finished {
  session: string;
  song: { id: string; title: string; artist: string | null };
  body: KaraokeSubmit;
  provisional: ScoreResult | null;
  /** The lyric lines' words, for the phrases of the number shown meanwhile. */
  lines: string[];
  /** The recording of the singer, sent once after the result; `null` without one. */
  voice: VoiceTake | null;
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" }
  | { kind: "playing" }
  | { kind: "finishing" };

interface Loaded {
  session: KaraokeSession;
  /** In version 2's shape, moved to the session's key. */
  reference: WorkersKaraokeReferenceV2;
  duration: number;
  range: MidiRange;
  /** Records the singer for the official score; `null` when the session or the browser does not. */
  recorder: VoiceRecorder | null;
}

/** How often the words and numbers on the stage are refreshed. */
const TICK_MS = 100;

/** The stage: tall on a phone, the video's shape from `sm` on, never taller than the window. */
export const STAGE_BOX =
  "relative isolate w-full overflow-hidden rounded-md text-white [text-shadow:0_1px_3px_rgba(0,0,0,0.9)] h-[max(440px,min(72svh,640px))] sm:aspect-video sm:h-auto sm:max-h-[calc(100svh-10rem)] sm:min-h-[400px]";

export function Singing({
  engine,
  song,
  latency,
  floor: knownFloor,
  onFinished,
  onQuit,
  onCalibrate,
}: {
  engine: () => KaraokeEngine;
  song: KaraokeSongView;
  latency: { latency_ms: number; calibrated: boolean };
  /** The room's level from the calibration, when there is one. */
  floor: number | null;
  onFinished: (f: Finished) => void;
  onQuit: () => void;
  onCalibrate: () => void;
}) {
  const { api, config } = useConnection();
  const reduced = useReducedMotion();
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState<{ now: number; score: number; rec: RecorderState }>({
    now: 0,
    score: 0,
    rec: "idle",
  });
  const [quitting, setQuitting] = useState(false);
  const [shift, setShift] = useState(() => loadKey(song.id, KARAOKE_MAX_SHIFT));
  const [reading, setReading] = useState<ReadingMode>(() => loadReading());
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef(new SongClock());
  const take = useRef<Take | null>(null);
  const alive = useRef(true);
  const recWait = useRef<number>(0);
  /** The key a session was started for, and which load is the latest. */
  const started = useRef<number | null>(null);
  const loadToken = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const loadedRef = useRef(loaded);
  loadedRef.current = loaded;

  // Load once per key: the session's signed links, the reference, the backing track. Meanwhile the
  // room is listened to for its level.
  useEffect(() => {
    alive.current = true;
    if (started.current === shift) return () => void (alive.current = false);
    started.current = shift;
    const token = ++loadToken.current;
    const audio = engine();
    const levels: number[] = [];
    const off = audio.onDetection((d) => levels.push(d.level));
    const link = (u: string) => (/^https?:/.test(u) ? u : joinUrl(config.baseUrl, u));
    void (async () => {
      try {
        const session = await api.rpc.karaoke.start({ params: { id: song.id }, body: { shift } });
        const res = await fetch(link(session.reference_url), { credentials: "same-origin" });
        if (!res.ok) throw new Error("這首歌的旋律拿不到");
        // Version 1 or 2, in version 2's shape, moved to the key the backing is in.
        const reference = shiftKaraokeReference(
          karaokeReferenceV2((await res.json()) as WorkersKaraokeReference),
          session.shift,
        );
        const duration = await audio.loadBacking(link(session.backing_url));
        if (token !== loadToken.current) return;
        off();
        const measured = levels.length >= 40 ? noiseFloor(levels) : null;
        audio.setFloor(Math.min(measured ?? Number.POSITIVE_INFINITY, knownFloor ?? measured ?? 0.002));
        take.current = new Take(referenceCurve(reference), {
          tolerance_cents: session.tolerance_cents,
          latency_ms: latency.latency_ms,
        });
        const range = midiRange(reference.pitch.midi, reference.notes);
        if (!alive.current || token !== loadToken.current) return;
        loadedRef.current?.recorder?.cancel();
        // The recording is placed by the same clock as the pitch track: the context's.
        const recorder = session.recording
          ? audio.recorder(session.recording, () => clockRef.current.songTime(audio.now()))
          : null;
        const linked = { ...session, video_url: session.video_url === null ? null : link(session.video_url) };
        setLoaded({ session: linked, reference, duration: Math.max(duration, 1), range, recorder });
        setPhase({ kind: "ready" });
      } catch (e) {
        off();
        if (alive.current && token === loadToken.current) setPhase({ kind: "error", message: describeError(e) });
      }
    })();
    return () => void (alive.current = false);
  }, [api, config.baseUrl, engine, song.id, latency.latency_ms, knownFloor, shift]);

  /** Another key, before the start: a new session with the backing in it. */
  const moveKey = (by: number) => {
    const next = Math.max(-KARAOKE_MAX_SHIFT, Math.min(KARAOKE_MAX_SHIFT, shift + by));
    if (next === shift || phase.kind !== "ready") return;
    saveKey(song.id, next);
    setLoaded(null);
    setPhase({ kind: "loading" });
    setShift(next);
  };
  const chooseReading = (m: ReadingMode) => {
    saveReading(m);
    setReading(m);
  };

  // Detections go to the take by the moment they were captured.
  useEffect(() => {
    if (!loaded) return;
    return engine().onDetection((d) => {
      if (phaseRef.current.kind !== "playing") return;
      const t = clockRef.current.songTimeAt(d.t);
      if (t === null || t < 0) return;
      take.current?.push(t, d.midi);
    });
  }, [engine, loaded]);

  // Leaving the screen: the backing stops, a recording is thrown away.
  useEffect(
    () => () => {
      window.clearTimeout(recWait.current);
      loadedRef.current?.recorder?.cancel();
      engine().stop();
    },
    [engine],
  );

  /** The recorder starts when the backing does (context time `at`), anew on a restart. */
  const recordFrom = (at: number) => {
    const r = loaded?.recorder;
    window.clearTimeout(recWait.current);
    if (!r) return;
    recWait.current = window.setTimeout(() => r.start(), Math.max(0, (at - engine().now()) * 1000));
  };

  const finish = useCallback(async () => {
    const t = take.current;
    if (!loaded || !t || phaseRef.current.kind === "finishing") return;
    const audio = engine();
    clockRef.current.pause(audio.now());
    audio.stop();
    window.clearTimeout(recWait.current);
    setPhase({ kind: "finishing" });
    const voice = loaded.recorder ? await loaded.recorder.stop() : null;
    const done = await finishTake(t, {
      calibrated: latency.calibrated,
      phrases: phrasesOf(loaded.reference),
      tolerance_cents: loaded.session.tolerance_cents,
      browser: browserName(navigator.userAgent),
    });
    const { id, title, artist } = loaded.session.song;
    const lines = (loaded.reference.lyrics?.lines ?? []).map((l) => l.text);
    onFinished({
      session: loaded.session.session,
      song: { id, title, artist },
      lines,
      body: { ...done.body, recording: voice !== null },
      provisional: done.provisional,
      voice,
    });
  }, [engine, loaded, latency.calibrated, onFinished]);

  const start = () => {
    if (phase.kind !== "ready") return;
    const at = engine().play(0);
    clockRef.current.start(at, 0);
    recordFrom(at);
    setPhase({ kind: "playing" });
  };
  const restart = () => {
    if (!take.current || phase.kind !== "playing") return;
    const audio = engine();
    audio.stop();
    take.current.restart();
    const at = audio.play(0);
    clockRef.current.start(at, 0);
    recordFrom(at);
  };
  const startRef = useRef(start);
  startRef.current = start;

  // Space starts the song.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el?.closest("input, textarea, button, [role=slider], [role=radio]")) return;
      if (phaseRef.current.kind !== "ready") return;
      e.preventDefault();
      startRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The lane, every frame; the words and numbers on the stage, ten times a second.
  useEffect(() => {
    if (!loaded) return;
    const el = canvas.current;
    const holder = box.current;
    const ctx = el?.getContext("2d") ?? null;
    const audio = engine();
    const colors: LaneColors | null = el ? laneColors(el) : null;
    const curve = referenceCurve(loaded.reference);
    let width = 0;
    let height = 0;
    let dpr = 1;
    let span = LANE_SECONDS;
    const size = () => {
      if (!el || !holder) return;
      width = holder.clientWidth;
      height = holder.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      span = width < 560 ? LANE_SECONDS_NARROW : LANE_SECONDS;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
    };
    size();
    const ro = typeof ResizeObserver === "function" && holder ? new ResizeObserver(size) : null;
    if (holder) ro?.observe(holder);
    let raf = 0;
    let last = 0;
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      const now = clockRef.current.songTime(audio.heard());
      if (ctx && colors && width > 0 && height > 0) {
        const view: LaneView = { width, height, now, span, ...loaded.range };
        drawLane(ctx, {
          view,
          reference: curve,
          notes: loaded.reference.notes,
          trail: take.current?.trail ?? [],
          tolerance: loaded.session.tolerance_cents,
          colors,
          dpr,
        });
      }
      if (ms - last >= TICK_MS) {
        last = ms;
        setTick({ now, score: take.current?.live.score ?? 0, rec: loaded.recorder?.state ?? "idle" });
      }
      if (phaseRef.current.kind === "playing" && now >= loaded.duration + 0.3) void finish();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro?.disconnect();
    };
  }, [engine, loaded, finish]);

  /** What the video follows: the song's time as heard, and whether it plays. */
  const songNow = useCallback(
    () => ({ time: clockRef.current.songTime(engine().heard()), playing: phaseRef.current.kind === "playing" }),
    [engine],
  );

  if (phase.kind === "error") {
    return (
      <Card aria-label={song.title} className="max-w-2xl gap-4">
        <CardHeader>
          <CardTitle>{song.title}</CardTitle>
        </CardHeader>
        <Refusal>{phase.message}</Refusal>
        <div>
          <Button variant="outline" onClick={onQuit}>
            <ArrowLeft aria-hidden />
            回到歌單
          </Button>
        </div>
      </Card>
    );
  }

  const duration = loaded?.duration ?? song.duration_s ?? 0;
  const playing = phase.kind === "playing";
  const lyrics = loaded?.reference.lyrics ?? null;
  const recordable = (loaded?.session.recording ?? null) !== null;
  const recording = (loaded?.recorder ?? null) !== null;
  const progress = duration > 0 ? Math.min(1, Math.max(0, tick.now) / duration) : 0;

  return (
    <section aria-label={`唱 ${song.title}`} className="grid min-w-0 gap-3">
      <div className={STAGE_BOX} data-stage>
        <StageBackground url={loaded?.session.video_url ?? null} song={songNow} reduced={reduced} />
        {/* Dim the picture so the words stay readable, a little more under the lyrics. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 bg-[linear-gradient(180deg,rgba(4,5,10,0.6)_0%,rgba(4,5,10,0.38)_42%,rgba(4,5,10,0.42)_60%,rgba(4,5,10,0.72)_100%)]"
        />

        <div className="absolute inset-x-0 top-0 flex items-start gap-4 px-4 pt-3 sm:px-6 sm:pt-4">
          <div className="grid min-w-0 flex-1 gap-0.5">
            <h2 className="flex min-w-0 items-center gap-2 text-[15px] font-semibold tracking-[-0.01em]">
              <span className="truncate">{song.title}</span>
              <HeardBadge lyrics={lyrics} />
            </h2>
            {song.artist && <p className="truncate text-[13px] text-white/75">{song.artist}</p>}
            {playing && recording && tick.rec === "recording" && (
              <p className="flex items-center gap-1.5 text-xs text-white/80">
                <Dot tone="brand" pulse={!reduced} />
                錄音中
              </p>
            )}
            {tick.rec === "over" && <p className="text-xs text-white/80">錄音超過上限,這次只有預估分數</p>}
          </div>
          <dl className="flex shrink-0 items-start gap-5 text-right sm:gap-7">
            <div className="grid gap-0.5">
              <dt className="text-xs text-white/75">預估</dt>
              <dd className="font-mono text-xl font-semibold tabular-nums sm:text-2xl" aria-live="off">
                {phase.kind === "playing" || phase.kind === "finishing" ? tick.score : "—"}
              </dd>
            </div>
            <div className="grid gap-0.5">
              <dt className="text-xs text-white/75">時間</dt>
              <dd className="font-mono text-[13px] leading-7 tabular-nums sm:leading-8">
                {clock(Math.max(0, tick.now))} / {clock(duration)}
              </dd>
            </div>
          </dl>
        </div>

        <div ref={box} className="absolute inset-x-4 top-[17%] h-[clamp(110px,27%,220px)] sm:inset-x-[5%] sm:top-[16%]">
          <canvas
            ref={canvas}
            className="absolute inset-0 size-full"
            role="img"
            aria-label="音高跑道:原唱的旋律和你唱的線"
          />
          <p aria-hidden className="absolute -top-5 right-0 flex items-center gap-3 text-[11px] text-white/75">
            <span className="flex items-center gap-1.5">
              <i className="h-1 w-3.5 rounded-full bg-white/85" />
              原唱
            </span>
            <span className="flex items-center gap-1.5">
              <i className="h-1 w-3.5 rounded-full bg-primary" />你
            </span>
          </p>
        </div>

        <div className="absolute inset-x-3 bottom-[7%] sm:inset-x-[6%] sm:bottom-[10%]">
          <Lyrics lyrics={lyrics} now={tick.now} loaded={loaded !== null} mode={reading} reduced={reduced} />
        </div>

        {phase.kind === "loading" && (
          <p className="absolute inset-0 grid place-items-center text-[15px]">
            準備伴唱帶中,先不要出聲
          </p>
        )}

        <div
          role="meter"
          aria-label="歌曲進度"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={Number(progress.toFixed(2))}
          className="absolute inset-x-0 bottom-0 h-[3px] bg-white/12"
        >
          <div className="h-full bg-white/70" style={{ width: `${progress * 100}%` }} />
        </div>
      </div>

      <div role="toolbar" aria-label="唱歌的控制" className="flex flex-wrap items-center gap-x-2 gap-y-2">
        {phase.kind === "ready" || phase.kind === "loading" ? (
          <Button size="sm" onClick={start} disabled={phase.kind !== "ready"}>
            <Play aria-hidden />
            開始
          </Button>
        ) : (
          <>
            <Button variant="ghost" size="sm" onClick={restart} disabled={!playing}>
              <RotateCcw aria-hidden />
              從頭開始
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void finish()}
              disabled={!playing}
              busy={phase.kind === "finishing"}
            >
              <Check aria-hidden />
              唱完了
            </Button>
          </>
        )}
        <KeyControl
          shift={shift}
          can={phase.kind === "ready"}
          busy={phase.kind === "loading" && started.current !== null && loaded === null}
          onMove={moveKey}
        />
        <ReadingToggle lyrics={lyrics} mode={reading} onMode={chooseReading} />
        {phase.kind === "ready" && (
          <Button variant="ghost" size="sm" onClick={onCalibrate}>
            <Timer aria-hidden />
            校正延遲
          </Button>
        )}
        <Button
          variant="ghost"
          size="sm"
          className="ml-auto"
          onClick={() => (playing ? setQuitting(true) : onQuit())}
          disabled={phase.kind === "finishing"}
        >
          <LogOut aria-hidden />
          離開
        </Button>
      </div>

      <div className="grid gap-1.5">
        <HeadphonesLine />
        <PrivacyLine recording={recording} />
        {recordable && loaded !== null && !recording && (
          <p className="text-[13px] text-muted-foreground">這個瀏覽器不能錄音,這次只有預估分數</p>
        )}
      </div>

      <ConfirmDialog
        open={quitting}
        title="離開這首歌"
        confirmLabel="離開"
        onConfirm={() => {
          setQuitting(false);
          window.clearTimeout(recWait.current);
          loaded?.recorder?.cancel();
          engine().stop();
          onQuit();
        }}
        onClose={() => setQuitting(false)}
      >
        這次唱的不會送出,也不會記分。
      </ConfirmDialog>
    </section>
  );
}

/** − key + : before the start only (the backing is made again for each key). */
function KeyControl({
  shift,
  can,
  busy,
  onMove,
}: {
  shift: number;
  can: boolean;
  busy: boolean;
  onMove: (by: number) => void;
}) {
  const why = can ? undefined : "開始前才能換調";
  return (
    <div role="group" aria-label="升降調" className="flex items-center gap-1">
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="降半音"
        title={why ?? "降半音"}
        disabled={!can || shift <= -KARAOKE_MAX_SHIFT}
        onClick={() => onMove(-1)}
      >
        <Minus aria-hidden />
      </Button>
      <span
        aria-live="polite"
        className={cn("w-10 text-center font-mono text-[13px] tabular-nums", busy && "text-muted-foreground")}
      >
        {keyLabel(shift)}
      </span>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label="升半音"
        title={why ?? "升半音"}
        disabled={!can || shift >= KARAOKE_MAX_SHIFT}
        onClick={() => onMove(1)}
      >
        <Plus aria-hidden />
      </Button>
    </div>
  );
}
