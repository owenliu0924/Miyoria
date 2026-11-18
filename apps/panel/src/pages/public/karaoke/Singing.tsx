// The singing screen: the backing track through Web Audio, the microphone through the pitch
// worklet, the lane on a canvas, the lyrics lit as they are sung, the running number. Before the
// start the key can be moved (the Core has the worker render the backing in it; the reference
// moves here by the same). At the song's end (or 「唱完了」) the track is encoded and handed on to
// be sent; nothing is sent while singing.

import { ArrowLeft, Check, Minus, Pause, Play, Plus, RotateCcw, Timer } from "lucide-react";
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
import { Button } from "@/components/ui/button";
import { Card, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import type { KaraokeEngine } from "./audio";
import { Bar, Fact, HeadphonesLine, PrivacyLine, Refusal } from "./bits";
import { noiseFloor } from "./latency";
import { SongClock } from "./clock";
import { LANE_SECONDS, LANE_SECONDS_NARROW, type LaneView, type MidiRange, midiRange } from "./lane";
import { drawLane, type LaneColors, laneColors } from "./lane-draw";
import { Lyrics } from "./Lyrics";
import { keyLabel, loadKey, loadReading, type ReadingMode, saveKey, saveReading } from "./lyric-text";
import { clock } from "./result-text";
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
}

type Phase =
  | { kind: "loading" }
  | { kind: "error"; message: string }
  | { kind: "ready" }
  | { kind: "playing" }
  | { kind: "paused" }
  | { kind: "finishing" };

interface Loaded {
  session: KaraokeSession;
  /** In version 2's shape, moved to the session's key. */
  reference: WorkersKaraokeReferenceV2;
  duration: number;
  range: MidiRange;
}

/** How often the words and numbers under the lane are refreshed. */
const TICK_MS = 100;

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
  const [phase, setPhase] = useState<Phase>({ kind: "loading" });
  const [loaded, setLoaded] = useState<Loaded | null>(null);
  const [tick, setTick] = useState({ now: 0, score: 0 });
  const [quitting, setQuitting] = useState(false);
  const [shift, setShift] = useState(() => loadKey(song.id, KARAOKE_MAX_SHIFT));
  const [reading, setReading] = useState<ReadingMode>(() => loadReading());
  const canvas = useRef<HTMLCanvasElement | null>(null);
  const box = useRef<HTMLDivElement | null>(null);
  const clockRef = useRef(new SongClock());
  const take = useRef<Take | null>(null);
  const alive = useRef(true);
  /** The key a session was started for, and which load is the latest. */
  const started = useRef<number | null>(null);
  const loadToken = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

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
        setLoaded({ session, reference, duration: Math.max(duration, 1), range });
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
      const kind = phaseRef.current.kind;
      if (kind !== "playing" && kind !== "paused") return;
      const t = clockRef.current.songTimeAt(d.t);
      if (t === null || t < 0) return;
      take.current?.push(t, d.midi);
    });
  }, [engine, loaded]);

  // Stop the backing when leaving the screen.
  useEffect(() => () => engine().stop(), [engine]);

  const finish = useCallback(async () => {
    const t = take.current;
    if (!loaded || !t || phaseRef.current.kind === "finishing") return;
    const audio = engine();
    clockRef.current.pause(audio.now());
    audio.stop();
    setPhase({ kind: "finishing" });
    const done = await finishTake(t, {
      calibrated: latency.calibrated,
      phrases: phrasesOf(loaded.reference),
      tolerance_cents: loaded.session.tolerance_cents,
      browser: browserName(navigator.userAgent),
    });
    const { id, title, artist } = loaded.session.song;
    const lines = (loaded.reference.lyrics?.lines ?? []).map((l) => l.text);
    onFinished({ session: loaded.session.session, song: { id, title, artist }, lines, ...done });
  }, [engine, loaded, latency.calibrated, onFinished]);

  const play = () => {
    const audio = engine();
    if (phase.kind === "ready") {
      clockRef.current.start(audio.play(0), 0);
      setPhase({ kind: "playing" });
    } else if (phase.kind === "paused") {
      const from = clockRef.current.songTime(audio.now());
      clockRef.current.resume(audio.play(from));
      setPhase({ kind: "playing" });
    }
  };
  const pause = () => {
    if (phase.kind !== "playing") return;
    const audio = engine();
    clockRef.current.pause(audio.now());
    audio.stop();
    setPhase({ kind: "paused" });
  };
  const restart = () => {
    if (!take.current) return;
    const audio = engine();
    audio.stop();
    take.current.restart();
    clockRef.current.start(audio.play(0), 0);
    setPhase({ kind: "playing" });
  };
  const toggle = useRef(() => {});
  toggle.current = () => (phase.kind === "playing" ? pause() : play());

  // Space pauses and goes on.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.code !== "Space" || e.repeat) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.closest("input, textarea, button, [role=slider]") ?? null)) return;
      e.preventDefault();
      toggle.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // The lane, every frame; the words and numbers under it, ten times a second.
  useEffect(() => {
    if (!loaded) return;
    const el = canvas.current;
    const holder = box.current;
    const ctx = el?.getContext("2d");
    if (!el || !holder || !ctx) return;
    const audio = engine();
    const colors: LaneColors = laneColors(el);
    const curve = referenceCurve(loaded.reference);
    let width = 0;
    let height = 0;
    let dpr = 1;
    let span = LANE_SECONDS;
    const size = () => {
      width = holder.clientWidth;
      height = holder.clientHeight;
      dpr = Math.min(2, window.devicePixelRatio || 1);
      // A phone shows less time, so a second stays wide enough to read.
      span = width < 640 ? LANE_SECONDS_NARROW : LANE_SECONDS;
      el.width = Math.round(width * dpr);
      el.height = Math.round(height * dpr);
    };
    size();
    const ro = new ResizeObserver(size);
    ro.observe(holder);
    let raf = 0;
    let last = 0;
    const frame = (ms: number) => {
      raf = requestAnimationFrame(frame);
      const now = clockRef.current.songTime(audio.heard());
      const view: LaneView = { width, height, now, span, ...loaded.range };
      if (width > 0 && height > 0) {
        drawLane(ctx, {
          view,
          reference: curve,
          notes: loaded.reference.notes,
          trail: take.current?.trail ?? [],
          colors,
          dpr,
        });
      }
      if (ms - last >= TICK_MS) {
        last = ms;
        setTick({ now, score: take.current?.live.score ?? 0 });
      }
      if (phaseRef.current.kind === "playing" && now >= loaded.duration + 0.3) void finish();
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, [engine, loaded, finish]);

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
  const begun = phase.kind === "playing" || phase.kind === "paused";

  return (
    <section aria-label={`唱 ${song.title}`} className="grid min-w-0 gap-4">
      <div className="flex flex-wrap items-end gap-x-8 gap-y-3">
        <div className="grid min-w-0 flex-1 gap-0.5">
          <h2 className="truncate text-[15px] font-semibold tracking-[-0.01em]">{song.title}</h2>
          {song.artist && <p className="truncate text-[13px] text-muted-foreground">{song.artist}</p>}
        </div>
        <dl className="flex flex-wrap gap-x-8 gap-y-3">
          <Fact label="即時分數">
            <span aria-live="off" className="font-mono">
              {begun ? tick.score : "—"}
            </span>
          </Fact>
          <Fact label="時間">
            <span className="font-mono">
              {clock(Math.max(0, tick.now))} / {clock(duration)}
            </span>
          </Fact>
          <Fact label="延遲">
            {latency.latency_ms} ms{latency.calibrated ? "" : "(估計)"}
          </Fact>
        </dl>
      </div>

      <div
        ref={box}
        className={cn(
          "relative h-60 w-full overflow-hidden rounded-md bg-well sm:h-72",
          phase.kind === "loading" && "animate-pulse",
        )}
      >
        <canvas
          ref={canvas}
          className="absolute inset-0 size-full"
          role="img"
          aria-label="音高跑道:原唱的旋律和你唱的線"
        />
        {phase.kind === "loading" && (
          <p className="absolute inset-0 grid place-items-center text-[13px] text-muted-foreground">
            準備伴唱帶中,先不要出聲
          </p>
        )}
      </div>
      <Bar value={duration > 0 ? Math.max(0, tick.now) / duration : 0} label="歌曲進度" />

      <Lyrics
        lyrics={loaded?.reference.lyrics ?? null}
        now={tick.now}
        loaded={loaded !== null}
        mode={reading}
        onMode={chooseReading}
      />

      <div className="flex flex-wrap items-center gap-2">
        {playing ? (
          <Button onClick={pause}>
            <Pause aria-hidden />
            暫停
          </Button>
        ) : (
          <Button onClick={play} disabled={phase.kind !== "ready" && phase.kind !== "paused"}>
            <Play aria-hidden />
            {phase.kind === "paused" ? "繼續" : "開始"}
          </Button>
        )}
        <Button variant="outline" onClick={restart} disabled={!begun}>
          <RotateCcw aria-hidden />
          從頭開始
        </Button>
        <Button
          variant="outline"
          onClick={() => void finish()}
          disabled={!begun}
          busy={phase.kind === "finishing"}
        >
          <Check aria-hidden />
          唱完了
        </Button>
        <KeyControl
          shift={shift}
          can={phase.kind === "ready"}
          busy={phase.kind === "loading" && started.current !== null && loaded === null}
          onMove={moveKey}
        />
        {phase.kind === "ready" && (
          <Button variant="ghost" onClick={onCalibrate}>
            <Timer aria-hidden />
            校正延遲
          </Button>
        )}
        <Button
          variant="ghost"
          className="ml-auto"
          onClick={() => (begun ? setQuitting(true) : onQuit())}
          disabled={phase.kind === "finishing"}
        >
          離開
        </Button>
      </div>

      <div className="grid gap-1.5">
        <HeadphonesLine />
        <PrivacyLine />
      </div>

      <ConfirmDialog
        open={quitting}
        title="離開這首歌"
        confirmLabel="離開"
        onConfirm={() => {
          setQuitting(false);
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
        variant="outline"
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
        className={cn("w-10 text-center font-mono text-sm tabular-nums", busy && "text-muted-foreground")}
      >
        {keyLabel(shift)}
      </span>
      <Button
        variant="outline"
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
