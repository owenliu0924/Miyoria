// A room's state for tests and the demo's defaults.

import type { RoomState } from "@miyoria/contracts/api";

const MB = 1024 * 1024;

export function roomState(patch: Partial<RoomState> = {}): RoomState {
  return {
    open: true,
    closed: null,
    mood: { word: "得意", face: "happy" },
    doing: "idle",
    detail: null,
    watch: false,
    paused: false,
    voice: { available: false, reason: "她的聲音現在沒有開" },
    quota: { capped: null, until: null },
    limits: { max_text_chars: 2000, max_files: 4, max_image_bytes: 5 * MB, max_file_bytes: 8 * MB },
    ...patch,
  };
}
