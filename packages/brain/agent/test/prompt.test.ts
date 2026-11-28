// The time-and-place lines (`whenAndWhere`): her room on the site is said as her room, not as a
// DM of the `web` platform (docs/design/her-room.md §2.4).

import { type ContextKey, roomContext } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { whenAndWhere } from "../src/prompt.js";

// 2026-11-28 04:05 UTC: 12:05 at UTC+8, a Saturday.
const NOW = new Date(Date.UTC(2026, 10, 28, 4, 5));
const OFFSET = 8 * 60;

describe("whenAndWhere", () => {
  it("says her room for a room", () => {
    const room = roomContext({ platform: "discord", id: "1001" });
    expect(whenAndWhere(room, NOW, OFFSET)).toBe(
      "- 時間:2026-11-28 12:05(星期六)\n- 地點:網站上她的房間(私訊)",
    );
  });

  it("says the platform's DM for any other DM, the web's included", () => {
    const discord: ContextKey = { platform: "discord", scope: null, channel: "9", kind: "dm" };
    expect(whenAndWhere(discord, NOW, OFFSET)).toContain("- 地點:discord 的私訊");
    const web: ContextKey = { platform: "web", scope: null, channel: "elsewhere", kind: "dm" };
    expect(whenAndWhere(web, NOW, OFFSET)).toContain("- 地點:web 的私訊");
  });
});
