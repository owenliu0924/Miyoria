// What may be attached to one line (docs/design/her-room.md §3.3): at most `max_files`, a picture
// (png, jpeg, webp, gif) up to `max_image_bytes`, anything else up to `max_file_bytes`. The Core
// checks again by the bytes; this only spares an upload that would be refused. No DOM.

import type { RoomState, RoomUpload } from "@miyoria/contracts/api";

type Limits = RoomState["limits"];

const IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/webp", "image/gif"]);
const IMAGE_EXT = /\.(png|jpe?g|webp|gif)$/i;

/** One file on its way up, or up. */
export interface Attached {
  key: string;
  name: string;
  size: number;
  kind: "image" | "file";
  /** A picture's own blob URL, for its thumbnail. */
  preview: string | null;
  /** How much went up, 0..1. */
  progress: number;
  upload: RoomUpload | null;
  error: string | null;
}

export function kindOfFile(file: { type: string; name: string }): "image" | "file" {
  return IMAGE_TYPES.has(file.type) || (file.type === "" && IMAGE_EXT.test(file.name)) ? "image" : "file";
}

const mb = (bytes: number) => Math.round((bytes / 1048576) * 10) / 10;

/** The Core's own sentence for a file over the limit (§3.10). */
export function tooBig(limits: Limits): string {
  return `檔案太大了(圖片最多 ${mb(limits.max_image_bytes)} MB,其他最多 ${mb(limits.max_file_bytes)} MB)`;
}

/** Which of `files` may join the `already` attached, and why the rest may not. */
export function admit<F extends { type: string; name: string; size: number }>(
  already: number,
  files: readonly F[],
  limits: Limits,
): { take: F[]; refused: string | null } {
  const take: F[] = [];
  let refused: string | null = null;
  for (const f of files) {
    if (f.size === 0) {
      refused ??= "這個檔案是空的";
      continue;
    }
    const max = kindOfFile(f) === "image" ? limits.max_image_bytes : limits.max_file_bytes;
    if (f.size > max) {
      refused = tooBig(limits);
      continue;
    }
    if (already + take.length >= limits.max_files) {
      refused = `一句最多附 ${limits.max_files} 個檔案`;
      continue;
    }
    take.push(f);
  }
  return { take, refused };
}

/** Whether the line can go: every file is up, and there is something to say. */
export function readyToSend(text: string, attached: readonly Attached[], maxChars: number): "ok" | "empty" | "uploading" | "failed" | "long" {
  if (attached.some((a) => a.error !== null)) return "failed";
  if (attached.some((a) => a.upload === null)) return "uploading";
  const t = text.trim();
  if (t === "" && attached.length === 0) return "empty";
  if (t.length > maxChars) return "long";
  return "ok";
}
