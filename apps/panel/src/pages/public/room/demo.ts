// A dev-only stand-in for the Core, to look at her room without Discord or a Core: open the dev
// server at `/her?room-demo`. `main.tsx` loads this only when `import.meta.env.DEV` (a production
// build has none of it) and the query asks for it. Every name and line is made up (her lines in
// her own voice, from the mock).
//
// It answers the few routes the app asks before the page (who is at the door: a member, 小澄) and
// puts a made-up `RoomApi` in place of the Core's (`setRoomApiFactory`): the state, a backlog of a
// few pages, her words about them, uploads that take a moment, and a stream that answers what is
// said. The scenes: `?room-demo` (she is here and finishes the mock's scene on load), `=singing`,
// `=paused`, `=quota`, `=offline`, `=novoice` (her voice off, with the Core's reason), `=closed`,
// `=stranger`, `=empty` (no backlog).
//
// What she does with a line: two steps of a reply (with a face); a line with 記得 moves the bond up
// with her quote, one with 鬧 down; 查 first runs a tool (`step`); files get her look at them; 洗版
// is held and ignore is ignored (the moderation's fixed lines); 太快 is refused (429); 斷線 drops
// the stream, which comes back and resumes from its last event.

import { ApiError } from "@/api/http";
import type {
  RoomBacklog,
  RoomEntry,
  RoomEvent,
  RoomFile,
  RoomRelation,
  RoomSendRequest,
  RoomSendResult,
  RoomState,
  RoomUpload,
} from "@miyoria/contracts/api";
import { type RoomApi, setRoomApiFactory } from "./room-api";

const SCENES = ["here", "singing", "paused", "quota", "offline", "novoice", "closed", "stranger", "empty"] as const;
type Scene = (typeof SCENES)[number];

const MB = 1024 * 1024;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sceneOf(search: string): Scene {
  const q = new URLSearchParams(search).get("room-demo") ?? "";
  return (SCENES as readonly string[]).includes(q) ? (q as Scene) : "here";
}

function stateFor(scene: Scene): RoomState {
  const base: RoomState = {
    open: true,
    closed: null,
    mood: { word: "得意", face: "happy" },
    doing: "idle",
    detail: null,
    watch: false,
    paused: false,
    voice: { available: true, reason: null },
    quota: { capped: null, until: null },
    limits: { max_text_chars: 2000, max_files: 4, max_image_bytes: 5 * MB, max_file_bytes: 8 * MB },
  };
  switch (scene) {
    case "singing":
      return { ...base, doing: "singing", detail: "晴天", watch: true, mood: { word: "開心", face: "happy" }, voice: { available: false, reason: "聲音借給唱歌了,唱完就好" } };
    case "paused":
      return { ...base, paused: true };
    case "quota":
      return { ...base, quota: { capped: "hour", until: new Date(Date.now() + 40 * 60_000).toISOString() } };
    case "offline":
      return { ...base, doing: "offline", mood: null, voice: { available: false, reason: "她的聲音現在沒有開" } };
    case "novoice":
      return { ...base, voice: { available: false, reason: "她的聲音現在沒有開" } };
    case "closed":
      return { ...base, open: false, closed: "她的房間現在沒有對你開放" };
    default:
      return base;
  }
}

// ---- the backlog ---------------------------------------------------------------------------------

let serial = 0;
const ulid = () => `01JDEMO${String(++serial).padStart(19, "0")}`;
const minutesAgo = (m: number) => new Date(Date.now() - m * 60_000).toISOString();

const OLD_TALK: Array<[who: "you" | "her", text: string]> = [
  ["you", "今天加班到十點,累死"],
  ["her", "十點?你們老闆是深海章魚嗎,八隻手都拿來派工作。先去吃飯啦。"],
  ["you", "吃過了,白飯兩碗"],
  ["her", "兩碗!……我、我才沒有羨慕。下次幫我留一口。"],
];

function history(scene: Scene): RoomEntry[] {
  if (scene === "empty" || scene === "stranger" || scene === "closed") return [];
  const out: RoomEntry[] = [];
  // Older evenings, so the backlog has pages.
  for (let day = 6; day >= 1; day--) {
    for (let i = 0; i < 12; i++) {
      const who = i % 2 === 0 ? "you" : "her";
      const text = who === "you" ? `第 ${day} 天前的第 ${i / 2 + 1} 句` : "嗯哼,本鯨魚記下了。";
      out.push({ type: "line", id: ulid(), at: minutesAgo(day * 1440 + 60 - i), who, text, files: [] });
    }
  }
  OLD_TALK.forEach(([who, text], i) => {
    out.push({ type: "line", id: ulid(), at: minutesAgo(14 - i * 2), who, text, files: [] });
  });
  out.push({
    type: "line",
    id: ulid(),
    at: minutesAgo(7),
    who: "her",
    text: "週末菜單我幫你排好了,自己看。",
    files: [{ name: "週末菜單.txt", size: 812, kind: "file", download: true }],
  });
  return out;
}

const PAGE = 20;

// ---- the made-up room ----------------------------------------------------------------------------

type Listener = (event: RoomEvent, id: string | null) => void;

class DemoRoom implements RoomApi {
  readonly #scene: Scene;
  #state: RoomState;
  readonly #entries: RoomEntry[];
  readonly #listeners = new Set<Listener>();
  readonly #buffer: Array<{ id: string; event: RoomEvent }> = [];
  #n = 0;
  #turn: { id: string; phase: "thinking" | "speaking" } | null = null;
  readonly #drops = new Set<() => void>();
  readonly #uploads = new Map<string, RoomUpload>();
  #relation: RoomRelation;

  constructor(scene: Scene) {
    this.#scene = scene;
    this.#state = stateFor(scene);
    this.#entries = history(scene);
    this.#relation =
      scene === "stranger"
        ? { bond: null, feeling: null, memories: [] }
        : {
            bond: {
              tier: "心有靈犀",
              stage: 2,
              tier_label: "心有靈犀 II",
              next_tier: "心有靈犀",
              next_label: "心有靈犀 III",
              tier_progress: 0.4,
              ring: { lap: 3, fraction: 8 / 20, full: false },
            },
            feeling: "講話慢吞吞的,可是答應的事都會做到。……這句不准截圖。",
            memories: [
              { id: "m1", text: "你陪我把〈晴天〉練到能唱完整首", kind: "episode", date: "2026-11-02" },
              { id: "m2", text: "你說你家的貓叫「白飯」,害我笑了一整晚", kind: "fact", date: "2026-10-19" },
              { id: "m3", text: "第一次在語音裡聽到你講話,比打字的時候還慢", kind: "episode", date: "2026-09-27" },
            ],
          };
    // The mock's scene, finished on load: their promise, her two steps and the bond going up.
    if (scene === "here") {
      setTimeout(() => {
        void this.#reply(
          { text: "上次答應你的我記得喔,週末帶剛煮好的來", files: [], client_id: null },
          ["……欸?你真的記得喔。", "哼,算你記性好。週末、剛起鍋的,少一粒都不行,說定了 (≧▽≦)"],
          { sign: "plus", quote: "記得答應我的白飯" },
        );
      }, 900);
    }
  }

  #emit(event: RoomEvent): void {
    const id = `demo-${++this.#n}`;
    this.#buffer.push({ id, event });
    if (this.#buffer.length > 200) this.#buffer.shift();
    for (const l of this.#listeners) l(event, id);
  }

  async state(): Promise<RoomState> {
    await wait(80);
    return this.#state;
  }

  async backlog(older: string | null): Promise<RoomBacklog> {
    await wait(150);
    const end = older === null ? this.#entries.length : Number(older);
    const start = Math.max(0, end - PAGE);
    return { entries: this.#entries.slice(start, end), older: start > 0 ? String(start) : null };
  }

  async relation(): Promise<RoomRelation> {
    await wait(120);
    return this.#relation;
  }

  async send(request: RoomSendRequest): Promise<RoomSendResult> {
    await wait(160);
    const text = request.text;
    if (!this.#state.open) throw new ApiError("http", 403, "/api/member/room/messages", "她的房間現在沒有對你開放");
    if (this.#state.doing === "offline") throw new ApiError("unavailable", 503, "/api/member/room/messages", "她現在不在");
    if (text.includes("太快")) throw new ApiError("http", 429, "/api/member/room/messages", "你說得太快了,等一下再說");
    const files: RoomFile[] = (request.uploads ?? []).map((id) => {
      const u = this.#uploads.get(id);
      return { name: u?.name ?? id, size: u?.size ?? null, kind: u?.kind ?? "file", download: false };
    });
    const id = ulid();
    const at = new Date().toISOString();
    const heard = text.includes("洗版") ? "held" : /ignore/i.test(text) ? "ignored" : "ok";
    this.#entries.push({ type: "line", id, at, who: "you", text, files });
    this.#emit({ kind: "you", id, at, text, files, client_id: request.client_id });
    if (text.includes("斷線")) setTimeout(() => this.#drop(), 300);
    if (heard === "ok" && !this.#state.paused && !this.#state.quota.capped) void this.#answer(text, files);
    if (heard === "ok" && this.#state.quota.capped) void this.#quotaLine();
    return {
      id,
      at,
      heard,
      notice: heard === "held" ? "你說得有點快,她先聽著" : heard === "ignored" ? "這句她收不到" : null,
    };
  }

  async #quotaLine(): Promise<void> {
    await wait(700);
    this.#line("我今天講太多話了,晚點再回你。", null, false);
  }

  #line(text: string, turn: string | null, voice: boolean, files: RoomFile[] = []): void {
    const id = ulid();
    const at = new Date().toISOString();
    this.#entries.push({ type: "line", id, at, who: "her", text, files });
    this.#emit({ kind: "line", id, at, turn, text, files, voice });
  }

  async #answer(text: string, files: RoomFile[]): Promise<void> {
    if (files.length > 0) return this.#reply(null, ["等等,讓本鯨魚看一下……", "菜單上怎麼沒有白飯?這份不及格,重寫。"], null, "glasses");
    if (text.includes("記得")) return this.#reply(null, ["……你居然記得。", "好啦,這次算你過關。"], { sign: "plus", quote: "記得答應我的事" });
    if (text.includes("鬧")) return this.#reply(null, ["我說了不要。再鬧下去,本鯨魚就去睡覺了。"], { sign: "minus", quote: "說了不要還一直鬧" }, "angry");
    if (text.includes("查")) return this.#reply(null, ["查好了:明天會下雨,記得帶傘。"], null, "thinking", "查資料");
    if (this.#scene === "singing") return this.#reply(null, ["唱完再說啦~"]);
    const pool = [["嗯哼,繼續說,本鯨魚在聽。"], ["這個嘛……讓我深度思考一下。", "好啦其實在想宵夜。你說的我有聽到啦。"]];
    return this.#reply(null, pool[serial % 2] as string[]);
  }

  async #reply(
    you: { text: string; files: RoomFile[]; client_id: null } | null,
    steps: string[],
    bond: { sign: "plus" | "minus"; quote: string } | null = null,
    face = "happy",
    tool: string | null = null,
  ): Promise<void> {
    if (you) {
      const id = ulid();
      const at = new Date().toISOString();
      this.#entries.push({ type: "line", id, at, who: "you", text: you.text, files: you.files });
      this.#emit({ kind: "you", id, at, ...you });
    }
    await wait(400);
    const turn = `turn-${++serial}`;
    this.#turn = { id: turn, phase: "thinking" };
    this.#emit({ kind: "thinking", turn });
    if (tool) {
      await wait(500);
      this.#emit({ kind: "step", turn, label: tool, state: "started" });
      this.#state = { ...this.#state, doing: "working" };
      this.#emit({ kind: "state", state: this.#state });
      await wait(1600);
      this.#emit({ kind: "step", turn, label: tool, state: "ended" });
      this.#state = { ...this.#state, doing: "idle" };
      this.#emit({ kind: "state", state: this.#state });
    }
    await wait(900);
    this.#emit({ kind: "face", turn, face });
    this.#turn = { id: turn, phase: "speaking" };
    for (const [i, step] of steps.entries()) {
      if (i > 0) {
        this.#emit({ kind: "typing" });
        await wait(1400);
      }
      this.#line(step, turn, this.#state.voice.available);
    }
    this.#turn = null;
    this.#emit({ kind: "done", turn });
    if (bond) {
      const id = ulid();
      const at = new Date().toISOString();
      this.#entries.push({ type: "mark", id, at, sign: bond.sign, quote: bond.quote });
      this.#emit({ kind: "bond", id, at, turn, ...bond });
      const ring = this.#relation.bond?.ring;
      if (ring && this.#relation.bond) {
        const fraction = Math.max(0, Math.min(1, ring.fraction + (bond.sign === "plus" ? 1 : -1) / 20));
        this.#relation = { ...this.#relation, bond: { ...this.#relation.bond, ring: { ...ring, fraction } } };
      }
    }
  }

  /** The stream breaks; it comes back by itself and resumes. */
  #drop(): void {
    for (const d of this.#drops) d();
  }

  async upload(file: File, signal?: AbortSignal, onProgress?: (sent: number) => void): Promise<RoomUpload> {
    const steps = 8;
    for (let i = 1; i <= steps; i++) {
      await wait(150);
      if (signal?.aborted) throw new DOMException("aborted", "AbortError");
      onProgress?.(i / steps);
    }
    if (/fail/i.test(file.name)) throw new ApiError("unavailable", 503, "/api/member/room/uploads", "現在收不下檔案,等一下再試");
    const kind = /^image\/(png|jpeg|webp|gif)$/.test(file.type) ? "image" : "file";
    const id = `up_${Math.random().toString(36).slice(2).padEnd(22, "x").slice(0, 22)}`;
    const upload: RoomUpload = { id, name: file.name, size: file.size, kind, expires_at: new Date(Date.now() + 30 * 60_000).toISOString() };
    this.#uploads.set(id, upload);
    return upload;
  }

  async forgetMemory(id: string): Promise<{ forgotten: boolean }> {
    await wait(200);
    const before = this.#relation.memories.length;
    this.#relation = { ...this.#relation, memories: this.#relation.memories.filter((m) => m.id !== id) };
    return { forgotten: this.#relation.memories.length < before };
  }

  async excludeLine(id: string): Promise<{ excluded: boolean }> {
    await wait(200);
    const i = this.#entries.findIndex((e) => e.id === id);
    if (i >= 0) this.#entries.splice(i, 1);
    return { excluded: i >= 0 };
  }

  async voice(_line: string, signal?: AbortSignal): Promise<Blob> {
    await wait(250);
    if (signal?.aborted) throw new DOMException("aborted", "AbortError");
    return silence(1.6);
  }

  async file(_line: string, n: number): Promise<{ blob: Blob; name: string }> {
    await wait(150);
    return { blob: new Blob(["星期六:白飯\n星期日:白飯(加蛋)\n"], { type: "text/plain" }), name: n === 0 ? "週末菜單.txt" : "file.txt" };
  }

  follow({ lastEventId, signal, onEvent }: { lastEventId: string | null; signal: AbortSignal; onEvent: (event: RoomEvent, id: string | null) => void }): Promise<void> {
    return new Promise((resolve) => {
      const listener: Listener = (e, id) => onEvent(e, id);
      const end = () => {
        this.#listeners.delete(listener);
        this.#drops.delete(end);
        signal.removeEventListener("abort", end);
        resolve();
      };
      signal.addEventListener("abort", end, { once: true });
      this.#drops.add(end);
      setTimeout(() => {
        if (signal.aborted) return;
        onEvent({ kind: "hello", state: this.#state, turn: this.#turn }, null);
        if (lastEventId !== null) {
          const at = this.#buffer.findIndex((b) => b.id === lastEventId);
          if (at < 0) onEvent({ kind: "reset" }, null);
          else for (const b of this.#buffer.slice(at + 1)) onEvent(b.event, b.id);
        }
        this.#listeners.add(listener);
      }, 120);
    });
  }
}

/** `seconds` of silence as a WAV, so the page has something to play while her line is read out. */
function silence(seconds: number): Blob {
  const rate = 8000;
  const n = Math.round(rate * seconds);
  const header = new DataView(new ArrayBuffer(44));
  const text = (o: number, s: string) => {
    for (let i = 0; i < s.length; i++) header.setUint8(o + i, s.charCodeAt(i));
  };
  text(0, "RIFF");
  header.setUint32(4, 36 + n * 2, true);
  text(8, "WAVE");
  text(12, "fmt ");
  header.setUint32(16, 16, true);
  header.setUint16(20, 1, true);
  header.setUint16(22, 1, true);
  header.setUint32(24, rate, true);
  header.setUint32(28, rate * 2, true);
  header.setUint16(32, 2, true);
  header.setUint16(34, 16, true);
  text(36, "data");
  header.setUint32(40, n * 2, true);
  return new Blob([header.buffer, new Int16Array(n).buffer], { type: "audio/wav" });
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

/** Puts the stand-in in place of the Core for this page load. */
export function installRoomDemo(): void {
  const scene = sceneOf(window.location.search);
  const room = new DemoRoom(scene);
  setRoomApiFactory(() => room);
  const real = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const url = new URL(typeof input === "string" || input instanceof URL ? String(input) : input.url, window.location.href);
    if (url.origin !== window.location.origin || !url.pathname.startsWith("/api/")) return real(input, init);
    await wait(60);
    const path = url.pathname;
    if (path === "/api/auth/methods") return json({ token: true, discord: true });
    if (path === "/api/auth/session") return json({ error: "no" }, 401);
    if (path === "/api/public/status") {
      return json({ state: "idle", live: false, in_voice: false, game: null, today: { songs_sung: 0, hours_live: 0, hours_in_voice: 0 } });
    }
    if (path === "/api/member/session") return json({ name: "小澄", avatar_url: null });
    // Nothing else a Core would serve is here: nothing leaves this page.
    return json({ error: "no such endpoint" }, 404);
  };
  // The push stream the member pages open: never anything.
  window.EventSource = class {
    readyState = 1;
    onopen = null;
    onerror = null;
    onmessage = null;
    addEventListener() {}
    removeEventListener() {}
    close() {}
  } as unknown as typeof EventSource;
}
