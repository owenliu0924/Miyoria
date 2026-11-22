import { describe, expect, it } from "vitest";
import { nodeCapabilities, whyNoWatch } from "../src/watch/probe.js";

const ok = async (): Promise<void> => {};
const broken = (message: string) => async (): Promise<void> => {
  throw new Error(message);
};

describe("watch probe", () => {
  it("watch_is_announced_when_ffmpeg_and_the_library_work", async () => {
    const why = await whyNoWatch({ ffmpeg: ok, library: ok });
    expect(why).toBeNull();
    expect(nodeCapabilities(why)).toEqual(["play_duck", "play_pause", "watch"]);
  });

  it("no_ffmpeg_leaves_watch_out_and_says_so", async () => {
    const why = await whyNoWatch({ ffmpeg: broken("spawn ffmpeg ENOENT"), library: ok });
    expect(why).toBe("watch is not announced: ffmpeg did not run (spawn ffmpeg ENOENT)");
    expect(nodeCapabilities(why)).toEqual(["play_duck", "play_pause"]);
  });

  it("a_library_that_does_not_load_leaves_watch_out_and_says_so", async () => {
    const why = await whyNoWatch({ ffmpeg: ok, library: broken("no native binding") });
    expect(why).toBe("watch is not announced: the Discord video library did not load (no native binding)");
    expect(nodeCapabilities(why)).not.toContain("watch");
  });
});
