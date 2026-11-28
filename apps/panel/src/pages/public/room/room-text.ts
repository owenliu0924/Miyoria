// The room's words and small decisions (docs/design/her-room.md §4, §7.3). No DOM.

import { isApiError } from "@/api/http";
import type { RoomDoing, RoomState } from "@miyoria/contracts/api";
import type { RoomLink } from "./room-store";

/** The capsule's hint: what will happen to what they say. Never a promise she cannot keep (§4). */
export function capsuleHint(state: RoomState | null): string {
  if (state?.paused) return "她現在暫停中,你說的她會記得";
  if (state?.quota.capped) {
    const at = state.quota.until ? clock(state.quota.until) : null;
    return at ? `她晚點才能回你(${at})` : "她晚點才能回你";
  }
  if (state?.doing === "offline") return "她現在不在";
  return "跟她說點什麼";
}

/** `HH:MM` in the viewer's time. */
export function clock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** A backlog line's time: `HH:MM` today, `M/D HH:MM` before. */
export function when(iso: string, today: Date = new Date()): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const same = d.getFullYear() === today.getFullYear() && d.getMonth() === today.getMonth() && d.getDate() === today.getDate();
  return same ? clock(iso) : `${d.getMonth() + 1}/${d.getDate()} ${clock(iso)}`;
}

/** What she is doing, after her mood (§4's table); `null`: nothing beyond the mood. */
export interface Doing {
  text: string;
  /** A link beside it (`去聽`, `去看` → `/watch`). */
  link: { label: string; href: string } | null;
  /** The singing bars instead of her face. */
  singing: boolean;
}

export function doingOf(state: RoomState, step: string | null, watchHref: string): Doing | null {
  if (state.paused) return { text: "她現在暫停中", link: null, singing: false };
  const watch = (label: string) => (state.watch ? { label, href: watchHref } : null);
  const d: RoomDoing = state.doing;
  switch (d) {
    case "offline":
      return { text: "她現在不在", link: null, singing: false };
    case "singing":
      return { text: state.detail ? `在唱〈${state.detail}〉` : "在唱歌", link: watch("去聽"), singing: true };
    case "playing":
      return { text: state.detail ? `在玩 ${state.detail}` : "在玩遊戲", link: watch("去看"), singing: false };
    case "live":
      return { text: "在直播", link: { label: "去看", href: watchHref }, singing: false };
    case "in_voice":
      return { text: "在語音頻道", link: null, singing: false };
    case "browsing":
      return { text: "在逛網站", link: null, singing: false };
    case "working":
      return { text: step ? `在幫你${step}` : "在幫你做事", link: null, singing: false };
    case "idle":
      return null;
  }
}

/** The mood words that read as pleased, for the small smiling face beside the word. */
const PLEASED = new Set(["開心", "得意", "害羞", "感激", "驚訝", "想念", "平靜"]);

export function pleased(word: string): boolean {
  return PLEASED.has(word);
}

/** The stream's state, when it is worth a word in the status line. */
export function linkWord(link: RoomLink): string | null {
  return link === "retrying" ? "連線中斷,正在重新連上" : null;
}

/** What went wrong with a send, an upload or a forget, in words a member reads. */
export function problemOf(error: unknown): string {
  if (isApiError(error)) {
    switch (error.kind) {
      case "network":
        return "連不上她的房間,沒有送出";
      case "unauthorized":
        return "登入已經失效,重新整理後再登入一次";
      case "not_provided":
        return "她的房間現在沒有開";
      default:
        // The Core's own fixed words (§3.10), never an internal error.
        return error.message || "沒有送出,再試一次";
    }
  }
  return "沒有送出,再試一次";
}

/** A size as people read it: `165 KB`, `1.2 MB`. */
export function sizeText(bytes: number | null): string {
  if (bytes === null) return "";
  return bytes < 1024 * 1024 ? `${Math.max(1, Math.round(bytes / 1024))} KB` : `${(bytes / 1048576).toFixed(1)} MB`;
}

/** A memory's kind, in a word; `null`: a kind without one. */
export function memoryKind(kind: string): string | null {
  if (kind === "episode") return "一起經歷的";
  if (kind === "fact") return "她知道的";
  return null;
}

/** A memory's date as the panel shows it: `11/02`. */
export function memoryDate(date: string): string {
  const m = /^\d{4}-(\d{2})-(\d{2})/.exec(date);
  return m ? `${m[1]}/${m[2]}` : date;
}

/** What 問她這件事 puts in the capsule. */
export function askAbout(text: string): string {
  return `還記得「${text}」嗎?`;
}

/** The fine print under the backlog and the panel (mock, with §3.7's words). */
export const FINE_BACKLOG = "她是 AI 角色。這裡跟私訊一樣,她不會在伺服器說出去;她記得的事在右上的環裡,可以請她忘掉。";
export const FINE_RELATION = "她是 AI 角色。她記得的就是這些;請她忘掉的,她會忘掉這件事。";
