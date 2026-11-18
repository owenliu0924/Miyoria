// A dev-only stand-in for the Core and the audio, to look at the karaoke page without either:
// open the dev server at `/karaoke?karaoke-demo`. `main.tsx` loads this only when
// `import.meta.env.DEV` (so a production build has none of it) and the query asks for it.
//
// What is faked: every `/api/*` answer the page needs (a member, the song list, a song being
// prepared, the signed files, the result, the official score and her comment), and the audio: no
// backing track plays and no microphone opens; a made-up singer follows the reference a little late
// and a little off, and the "recording" is a few empty bytes. What is real: the page, the lane, the
// clock, `Take`, `LiveScore`, the encoded track, and the score (`scoreSinging` runs here on what the
// page sends, the way Core would).
//
// The songs: 紙船 has no video (the still behind the stage); 夜空中最亮的星 says it has one but its
// link leads nowhere, so the stage falls back to the still. A singing goes 預估 → 正在算 → 正式分數
// (a little higher than the estimate, which stays shown small); the second of 最近唱的 had the
// backing in its recording (`bleed`). No real video is made: that would need a file or recording a
// canvas for the whole song.

import type {
  KaraokeOverview,
  KaraokeResult,
  KaraokeSession,
  KaraokeSongView,
  KaraokeSubmit,
} from "@miyoria/contracts/api";
import type {
  WorkersKaraokeLineV2,
  WorkersKaraokePiece,
  WorkersKaraokeReferenceV2,
} from "@miyoria/contracts/workers/karaoke";
import { decodeTrack, fromBase64, scoreSinging, TRACK_HZ } from "@miyoria/play/karaoke/score";
import { type KaraokeEngine, setEngineFactory } from "./audio";
import type { Detection } from "./pitch";
import { type RecorderState, type RecordingLimits, recordingOffsetMs, type VoiceRecorder, type VoiceTake } from "./recorder";

// ---------------------------------------------------------------------------
// a made-up song: an original tune and words

const HZ = 50;
/** [start, length, midi] of each note; the words of each line. */
const TUNE: [number, number, number][] = [];
const WORDS = [
  "窗外的燈一盞一盞亮起來",
  "我把今天的心事折成紙船",
  "順著夜色慢慢地往前漂",
  "你說明天也會是晴天",
  "跟著拍子輕輕地唱",
  "把想說的話都交給風",
  "等到星星都睡著以後",
  "再一起回家吧",
];
const LINE_S = 7;
const FIRST = 2;
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12];
/** The demo's own pinyin (the worker gives it with pypinyin). */
const PINYIN: Record<string, string> = Object.fromEntries(
  (
    "窗chuāng 外wài 的de 燈dēng 一yì 盞zhǎn 亮liàng 起qǐ 來lái 我wǒ 把bǎ 今jīn 天tiān 心xīn 事shì 折zhé " +
    "成chéng 紙zhǐ 船chuán 順shùn 著zhe 夜yè 色sè 慢màn 地de 往wǎng 前qián 漂piāo 你nǐ 說shuō 明míng 也yě " +
    "會huì 是shì 晴qíng 跟gēn 拍pāi 子zi 輕qīng 唱chàng 想xiǎng 話huà 都dōu 交jiāo 給gěi 風fēng 等děng 到dào " +
    "星xīng 睡shuì 以yǐ 後hòu 再zài 回huí 家jiā 吧ba"
  )
    .split(" ")
    .map((w) => [w.slice(0, 1), w.slice(1)]),
);
/** The fourth line is one the recogniser did not hear as written: shown, not aligned. */
const DOUBTFUL_LINE = 3;
const lines: WorkersKaraokeLineV2[] = WORDS.map((text, i) => {
  const start = FIRST + i * LINE_S;
  // Six notes a line, the last one held.
  let t = start;
  for (let k = 0; k < 6; k++) {
    const len = k === 5 ? 1.8 : 0.7;
    const degree = SCALE[(i * 3 + k * 2) % SCALE.length] as number;
    TUNE.push([t, len - 0.06, 62 + degree - (i % 2 === 0 ? 0 : 2)]);
    t += len;
  }
  const aligned = i !== DOUBTFUL_LINE;
  const chars = [...text];
  const step = (t - start - 0.3) / chars.length;
  const pieces: WorkersKaraokePiece[] = chars.map((c, k) => ({
    text: c,
    sung: true,
    start: aligned ? start + k * step : null,
    end: aligned ? start + (k + 1) * step : null,
    reading: PINYIN[c] ?? null,
    roman: null,
  }));
  return {
    start,
    end: t,
    text,
    status: aligned ? ("matched" as const) : ("uncertain" as const),
    source: "found" as const,
    similarity: aligned ? 1 : 0.62,
    heard: text,
    aligned,
    pieces,
    edited: false,
  };
});
const DURATION = FIRST + WORDS.length * LINE_S + 3;

const curve: (number | null)[] = Array.from({ length: Math.ceil(DURATION * HZ) }, (_, i) => {
  const t = i / HZ;
  const note = TUNE.find(([s, len]) => t >= s && t < s + len);
  if (!note) return null;
  const [s, len, midi] = note;
  const into = t - s;
  // A scoop into each note and vibrato on the held ones.
  const scoop = into < 0.06 ? -0.6 * (1 - into / 0.06) : 0;
  const vib = len > 1 && into > 0.5 ? 0.35 * Math.sin(2 * Math.PI * 5.6 * into) : 0;
  return midi + scoop + vib;
});

const REFERENCE: WorkersKaraokeReferenceV2 = {
  format: "miyoria.karaoke.reference",
  version: 2,
  id: "demo-song",
  title: "紙船",
  artist: "示範",
  duration_s: DURATION,
  backing: "karaoke.m4a",
  pitch: { hz: HZ, start: 0, midi: curve },
  notes: TUNE.map(([start, len, midi]) => ({
    start,
    end: start + len,
    midi,
    source: "pitch" as const,
    line: null,
    char: null,
  })),
  lyrics: {
    provider: "demo",
    source: "found",
    language: "zh",
    timing: "char",
    check: { matched: WORDS.length - 1, uncertain: 1, failed: 0, verdict: "kept" },
    lines,
  },
  quality: { ok: true, reason: null, voiced_ratio: 0.8, notes: TUNE.length, lead_split: true },
  made: { pitch: "demo", notes: "demo", lyrics: "demo", asr: "demo", aligner: "demo" },
};

// ---------------------------------------------------------------------------
// the Core

const song = (over: Partial<KaraokeSongView>): KaraokeSongView => ({
  id: "demo-song",
  title: "紙船",
  artist: "示範",
  duration_s: DURATION,
  state: "ready",
  stage: null,
  progress: 1,
  position: null,
  error: null,
  lyrics: true,
  lyrics_source: "found",
  notes: TUNE.length,
  video: false,
  mine: false,
  best: null,
  sung: 0,
  ...over,
});

let preparingPolls = 0;
const STAGES = ["queued", "download", "separate", "lead", "reference", "encode", "lyrics"];

function preparing(): KaraokeSongView {
  const n = preparingPolls++;
  const stage = STAGES[Math.min(STAGES.length - 1, 2 + Math.floor(n / 6))] as string;
  return song({
    id: "demo-prep",
    title: "春日影",
    artist: "示範樂團",
    state: "preparing",
    stage,
    progress: Math.min(0.95, 0.36 + n * 0.02),
    position: null,
    mine: true,
    duration_s: null,
  });
}

function overview(): KaraokeOverview {
  return {
    open: true,
    preparing: true,
    songs: [
      song({ best: 84.6, sung: 4 }),
      song({ id: "d2", title: "夜空中最亮的星", artist: "逃跑計劃", duration_s: 252, best: 77.2, sung: 2, video: true }),
      song({ id: "d3", title: "群青", artist: "YOASOBI", duration_s: 248, lyrics_source: "heard" }),
      song({ id: "d4", title: "小幸運", artist: "田馥甄", duration_s: 265, lyrics: false, lyrics_source: null }),
      song({ id: "d5", title: "First Love", artist: "宇多田ヒカル", duration_s: 259, best: 69.8, sung: 1 }),
      preparing(),
      song({
        id: "demo-fail",
        title: "一首很長的歌",
        artist: null,
        state: "failed",
        error: "這首超過 8 分鐘,沒有準備",
        mine: true,
        duration_s: null,
      }),
    ],
    limits: { daily: 10, used: 3, max_minutes: 8 },
    tolerance_cents: 50,
    comments: true,
    recent: [
      { session: "demo-old", song: "demo-song", title: "紙船", total: 84.6, unranked: false, at: ago(26) },
      { session: "demo-old2", song: "d2", title: "夜空中最亮的星", total: 77.2, unranked: false, at: ago(60 * 20) },
    ],
  };
}

function ago(minutes: number): string {
  return new Date(Date.now() - minutes * 60_000).toISOString();
}

const results = new Map<string, { result: KaraokeResult; polls: number; uploaded: boolean }>();
/** The key of each session, and of the one singing now (the made-up singer follows it). */
const keys = new Map<string, number>();
let singingKey = 0;
const COMMENT =
  "第三句那個長音拉得很穩,還帶了一點顫音,我有聽到喔。副歌開頭稍微搶拍了,下次跟著伴奏的鼓再等半拍就更好了。";

function scored(body: KaraokeSubmit, session: string): KaraokeResult {
  const bytes = fromBase64(body.track) ?? new Uint8Array();
  const shift = keys.get(session) ?? 0;
  const r = scoreSinging({
    reference: { hz: HZ, start: 0, midi: curve.map((m) => (m === null ? null : m + shift)) },
    sung: { hz: TRACK_HZ, midi: decodeTrack(bytes) },
    latency_ms: body.latency_ms,
    calibrated: body.calibrated,
    phrases: lines.map((l) => ({ start: l.start, end: l.end })),
  });
  return {
    ...r,
    session,
    source: "estimate",
    voice: { state: body.recording ? "waiting" : "none", estimate_total: null, checks: [] },
    song: { id: "demo-song", title: "紙船", artist: "示範" },
    at: new Date().toISOString(),
    phrases: r.phrases.map((p) => ({ ...p, text: WORDS[p.index] ?? null })),
    unranked: r.flags.too_perfect,
    client_total: body.client_total ?? null,
    latency_ms: body.latency_ms,
    best_before: 84.6,
    comment: { state: "waiting", text: null },
  } as unknown as KaraokeResult;
}

/** The recording's score: a little higher than the estimate, which is kept to show beside it. */
function officially(r: KaraokeResult): KaraokeResult {
  const total = Math.min(100, Math.round((r.total + 4.6) * 10) / 10);
  return {
    ...r,
    source: "voice",
    total,
    pitch: { ...r.pitch, score: Math.min(r.pitch.max, Math.round((r.pitch.score + 4.6) * 10) / 10) },
    voice: { state: "scored", estimate_total: r.total, checks: [] },
  };
}

/** A full singing for the result opened from the list: a made-up track run through the score. */
function oldResult(session: string): KaraokeResult {
  const sung = curve.map((m, i) => (m === null ? null : m - 12 + 0.15 * Math.sin(i / 7) + (i > 1500 && i < 1800 ? 0.9 : 0)));
  const track = { hz: HZ, midi: sung.map((m, i) => sung[i + 4] ?? m) };
  const r = scoreSinging({
    reference: { hz: HZ, start: 0, midi: curve },
    sung: track,
    latency_ms: 0,
    calibrated: true,
    phrases: lines.map((l) => ({ start: l.start, end: l.end })),
  });
  // The second of the recent ones had the backing in its recording: not a best.
  const bleed = session === "demo-old2";
  return {
    ...r,
    session,
    source: "voice",
    voice: { state: "scored", estimate_total: Math.round((r.total - 3.1) * 10) / 10, checks: bleed ? ["bleed"] : [] },
    song: { id: "demo-song", title: "紙船", artist: "示範" },
    at: ago(26),
    phrases: r.phrases.map((p) => ({ ...p, text: WORDS[p.index] ?? null })),
    unranked: bleed,
    client_total: r.total,
    latency_ms: 140,
    best_before: 79.3,
    comment: { state: "said", text: COMMENT },
  } as unknown as KaraokeResult;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

let sessions = 0;

function answer(method: string, path: string, body: unknown): Response | null {
  if (path === "/api/auth/methods") return json({ token: true, discord: true });
  if (path === "/api/auth/session") return json({ error: "no" }, 401);
  if (path === "/api/public/status") {
    return json({
      state: "idle",
      live: false,
      in_voice: false,
      game: null,
      today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 },
    });
  }
  if (path === "/api/member/session") return json({ name: "小魚乾", avatar_url: null });
  if (path === "/api/member/karaoke") return json(overview());
  if (path === "/api/member/karaoke/songs" && method === "POST") {
    const text = (body as { text?: string }).text ?? "";
    if (text.includes("limit")) return json({ error: "今天已經準備了 10 首,明天再來" }, 409);
    return json({ song: preparing(), created: true });
  }
  if (path === "/api/member/karaoke/songs/demo-prep") return json(preparing());
  const start = /^\/api\/member\/karaoke\/songs\/([^/]+)\/sessions$/.exec(path);
  if (start && method === "POST") {
    const id = `demo-${++sessions}`;
    const shift = (body as { shift?: number } | undefined)?.shift ?? 0;
    keys.set(id, shift);
    singingKey = shift;
    const backing = shift === 0 ? "karaoke.m4a" : `karaoke.k${shift > 0 ? "+" : "-"}${Math.abs(shift)}.m4a`;
    // 夜空中最亮的星 "has" a video whose link leads nowhere: the stage shows the still instead.
    const video = start[1] === "d2" ? `/karaoke-demo-missing-${id}.mp4` : null;
    const s: KaraokeSession = {
      session: id,
      song: song({ video: video !== null }),
      backing_url: `/api/member/karaoke/files/${id}/${backing}?exp=1&sig=demo`,
      reference_url: `/api/member/karaoke/files/${id}/reference.json?exp=1&sig=demo`,
      video_url: video,
      expires_at: new Date(Date.now() + 600_000).toISOString(),
      tolerance_cents: 50,
      frame_hz: TRACK_HZ,
      shift,
      recording: { max_bytes: 8 * 1024 * 1024, max_seconds: Math.ceil(DURATION) + 30 },
    };
    return json(s);
  }
  const voice = /^\/api\/member\/karaoke\/sessions\/([^/]+)\/voice$/.exec(path);
  if (voice && method === "POST") {
    const kept = results.get(voice[1] as string);
    if (!kept || kept.uploaded) return json({ error: "這次的錄音已經收過了" }, 409);
    kept.uploaded = true;
    kept.polls = 0;
    kept.result = { ...kept.result, voice: { ...kept.result.voice, state: "scoring" } };
    return json({ state: "scoring" }, 202);
  }
  if (/\/reference\.json$/.test(path)) return json(REFERENCE);
  const submit = /^\/api\/member\/karaoke\/sessions\/([^/]+)\/result$/.exec(path);
  if (submit && method === "POST") {
    const id = submit[1] as string;
    const result = scored(body as KaraokeSubmit, id);
    results.set(id, { result, polls: 0, uploaded: false });
    return json(result);
  }
  const one = /^\/api\/member\/karaoke\/sessions\/([^/]+)$/.exec(path);
  if (one) {
    const id = one[1] as string;
    const kept = results.get(id);
    if (!kept) return json(oldResult(id));
    kept.polls++;
    const r = kept.result;
    // The recording is scored on the third look after it arrived; her comment comes after that.
    if (r.voice.state === "scoring" && kept.polls >= 3) {
      kept.result = officially(r);
      kept.polls = 0;
    } else if (r.voice.state !== "waiting" && r.voice.state !== "scoring" && kept.polls >= 2) {
      kept.result = { ...r, comment: { state: "said", text: COMMENT } };
    }
    return json(kept.result);
  }
  if (path.startsWith("/api/")) return json({ error: "no such endpoint" }, 404);
  return null;
}

function installFetch(): void {
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, window.location.href);
    const method = init?.method ?? (input instanceof Request ? input.method : "GET");
    let body: unknown;
    const raw = init?.body ?? (input instanceof Request && method !== "GET" ? await input.clone().text() : undefined);
    if (typeof raw === "string" && raw !== "") body = JSON.parse(raw);
    await new Promise((r) => setTimeout(r, 120));
    return answer(method, url.pathname, body) ?? real(input, init);
  };
}

// ---------------------------------------------------------------------------
// the audio: a made-up singer, a little late and a little off

class DemoEngine implements KaraokeEngine {
  #playing: { at: number; offset: number } | null = null;
  #beeps: number[] = [];
  #timer = 0;
  #floor = 0.002;
  readonly #listeners = new Set<(d: Detection) => void>();

  now(): number {
    return performance.now() / 1000;
  }
  heard(): number {
    return this.now() - 0.02;
  }
  estimateLatencyMs(): number {
    return 45;
  }
  async openMic() {
    if (!this.#timer) this.#timer = window.setInterval(() => this.#emit(), 10);
    return { groupId: "demo-mic" };
  }
  setFloor(rms: number): void {
    this.#floor = rms;
  }
  onDetection(fn: (d: Detection) => void): () => void {
    this.#listeners.add(fn);
    return () => this.#listeners.delete(fn);
  }
  async loadBacking(): Promise<number> {
    await new Promise((r) => setTimeout(r, 900));
    return DURATION;
  }
  play(offset: number): number {
    const at = this.now() + 0.12;
    this.#playing = { at, offset };
    return at;
  }
  stop(): void {
    this.#playing = null;
  }
  beeps(at: readonly number[]): void {
    this.#beeps = [...at];
  }
  recorder(limits: RecordingLimits, songTime: () => number): VoiceRecorder {
    return new DemoRecorder(limits, songTime);
  }
  close(): void {
    window.clearInterval(this.#timer);
    this.#timer = 0;
    this.#listeners.clear();
  }

  #emit(): void {
    const t = this.now() - 0.03;
    let midi: number | null = null;
    let level = 0.0012 + 0.0004 * Math.random();
    // A clap 130 ms after each beep.
    if (this.#beeps.some((b) => t >= b + 0.13 && t < b + 0.2)) level = 0.08;
    const p = this.#playing;
    if (p && t >= p.at) {
      // The singer hears the song 30 ms late and answers 50 ms after that.
      const s = p.offset + (t - p.at) - 0.08;
      const ref = curve[Math.round(s * HZ)];
      // An octave below, a little flat, rushing the second half of line 4.
      const line = Math.floor((s - FIRST) / LINE_S);
      const wobble = 0.12 * Math.sin(t * 9) + (Math.random() - 0.5) * 0.15;
      const off = line === 3 ? 0.8 : -0.1;
      if (ref !== null && ref !== undefined && Math.random() > 0.04) {
        midi = ref - 12 + singingKey + off + wobble;
        level = 0.05;
      }
    }
    const d: Detection = {
      t,
      midi: level > this.#floor * 2 ? midi : null,
      clarity: midi === null ? 0.4 : 0.96,
      rms: level,
      level,
      levelT: t,
    };
    for (const fn of this.#listeners) fn(d);
  }
}

/** No microphone: a "recording" of empty bytes, about as large as a real one would be. */
class DemoRecorder implements VoiceRecorder {
  #state: RecorderState = "idle";
  #offset: number | null = null;
  #began = 0;
  #timer = 0;
  readonly #limits: RecordingLimits;
  readonly #songTime: () => number;

  constructor(limits: RecordingLimits, songTime: () => number) {
    this.#limits = limits;
    this.#songTime = songTime;
  }
  get state(): RecorderState {
    return this.#state;
  }
  start(): void {
    window.clearTimeout(this.#timer);
    this.#state = "recording";
    this.#offset = null;
    // A real recorder says it began a moment after it was asked.
    this.#timer = window.setTimeout(() => {
      this.#offset = recordingOffsetMs(this.#songTime());
      this.#began = performance.now();
    }, 30);
  }
  async stop(): Promise<VoiceTake | null> {
    window.clearTimeout(this.#timer);
    const seconds = (performance.now() - this.#began) / 1000;
    const offset = this.#offset;
    const was = this.#state;
    this.#state = "idle";
    if (was !== "recording" || offset === null || seconds > this.#limits.max_seconds) return null;
    const blob = new Blob([new Uint8Array(Math.max(1, Math.round(seconds * 4000)))], { type: "audio/webm" });
    return { blob, type: "audio/webm", offset_ms: offset };
  }
  cancel(): void {
    window.clearTimeout(this.#timer);
    this.#state = "idle";
  }
}

export function installDemo(): void {
  installFetch();
  setEngineFactory(() => new DemoEngine());
  // The page checks for Web Audio first; the demo needs none.
  const w = window as unknown as Record<string, unknown>;
  w.AudioWorkletNode ??= function AudioWorkletNode() {};
}
