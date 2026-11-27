// What people attached to their messages, kept for a short while so `workspace_attach` can find
// it: the message's own files and the same person's recent ones in the same place, newest first.

import type { IncomingMessage } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { KEEP_MS, MAX_MESSAGES, MessageFilesBook, recordRunFiles } from "../src/message-files.js";
import { channel, dm, line } from "./harness.js";

const MINUTE = 60_000;
const T = Date.UTC(2026, 10, 23, 4);
const C1 = channel("c1");
const C2 = channel("c2");

function say(
  where: typeof C1,
  who: string,
  id: string,
  at: number,
  files: { name: string; url?: string; id?: string | null; size?: number | null }[] = [],
  extra: Partial<IncomingMessage> = {},
): IncomingMessage {
  const base = line(where, who, "text", extra);
  return {
    ...base,
    id: { context: where, id },
    ts: new Date(at).toISOString(),
    attachments: files.map((f) => ({
      url: f.url ?? `https://cdn.example/${f.name}`,
      filename: f.name,
      content_type: null,
      id: f.id ?? null,
      size: f.size ?? null,
    })),
  };
}

const names = (book: MessageFilesBook, where: typeof C1, id: string, withinMs?: number) =>
  book
    .filesOf({ context: where, id }, withinMs === undefined ? undefined : { withinMs })
    .map((f) => f.name);

describe("MessageFilesBook", () => {
  it("gives the message's files and the same person's earlier ones, the newest first", () => {
    const book = new MessageFilesBook(() => T + 8 * MINUTE);
    recordRunFiles(book, [
      say(C1, "amy", "a1", T, [{ name: "old.png" }]),
      say(C1, "amy", "a2", T + 5 * MINUTE, [{ name: "mid.csv" }]),
      say(C1, "amy", "a3", T + 8 * MINUTE, [{ name: "now1.zip" }, { name: "now2.txt" }]),
    ]);
    expect(names(book, C1, "a3")).toEqual(["now1.zip", "now2.txt", "mid.csv", "old.png"]);
    // The anchor is the message asked about: later messages are not "before it".
    expect(names(book, C1, "a2")).toEqual(["mid.csv", "old.png"]);
  });

  it("by default looks back ten minutes, and takes another window when asked", () => {
    const book = new MessageFilesBook(() => T + 30 * MINUTE);
    recordRunFiles(book, [
      say(C1, "amy", "a1", T + 12 * MINUTE, [{ name: "far.png" }]),
      say(C1, "amy", "a2", T + 25 * MINUTE, [{ name: "near.png" }]),
      say(C1, "amy", "a3", T + 30 * MINUTE, []),
    ]);
    expect(names(book, C1, "a3")).toEqual(["near.png"]);
    expect(names(book, C1, "a3", 30 * MINUTE)).toEqual(["near.png", "far.png"]);
    expect(names(book, C1, "a3", 0)).toEqual([]);
  });

  it("never mixes people or places, and leaves bots out", () => {
    const book = new MessageFilesBook(() => T + 2 * MINUTE);
    const bot = say(C1, "bot", "b1", T + MINUTE, [{ name: "bot.txt" }]);
    recordRunFiles(book, [
      say(C1, "amy", "a1", T, [{ name: "amy.png" }]),
      say(C1, "bea", "b0", T + MINUTE, [{ name: "bea.png" }]),
      say(C2, "amy", "x1", T + MINUTE, [{ name: "elsewhere.png" }]),
      say(dm("d1"), "amy", "d1", T + MINUTE, [{ name: "dm.png" }]),
      { ...bot, author: { ...bot.author, is_bot: true } },
      say(C1, "amy", "a2", T + 2 * MINUTE, []),
    ]);
    expect(names(book, C1, "a2")).toEqual(["amy.png"]);
    expect(names(book, C1, "b0")).toEqual(["bea.png"]);
    expect(names(book, C2, "x1")).toEqual(["elsewhere.png"]);
    expect(names(book, C1, "b1")).toEqual([]);
    const files = book.filesOf({ context: C1, id: "a2" });
    expect(files[0]).toMatchObject({ who: "test:amy", size: null });
  });

  it("knows only messages it has seen, and gives an attachment once", () => {
    const book = new MessageFilesBook(() => T + MINUTE);
    expect(names(book, C1, "unseen")).toEqual([]);
    recordRunFiles(book, [
      say(C1, "amy", "a1", T, [{ name: "a.png", id: "att1" }]),
      say(C1, "amy", "a2", T + MINUTE, [
        { name: "a-again.png", id: "att1" },
        { name: "b.png", id: "att2" },
      ]),
    ]);
    expect(names(book, C1, "a2")).toEqual(["a-again.png", "b.png"]);
    // Recorded again (the same run read twice): one entry, as the last record says.
    recordRunFiles(book, [say(C1, "amy", "a2", T + MINUTE, [{ name: "b.png", id: "att2" }])]);
    expect(names(book, C1, "a2")).toEqual(["b.png", "a.png"]);
  });

  it("carries the forwarded message's files too, with the sender's size and id", () => {
    const book = new MessageFilesBook(() => T);
    const fwd = say(C1, "amy", "a1", T, [], {
      forwarded: [
        {
          text: "fw",
          attachments: [
            {
              url: "https://cdn.example/f.pdf",
              filename: "f.pdf",
              content_type: null,
              id: "f1",
              size: 9,
            },
          ],
        } as never,
      ],
    });
    recordRunFiles(book, [fwd]);
    expect(book.filesOf({ context: C1, id: "a1" })).toEqual([
      { who: "test:amy", name: "f.pdf", url: "https://cdn.example/f.pdf", size: 9, id: "f1" },
    ]);
  });

  it("forgets after thirty minutes and keeps at most 256 messages", () => {
    let now = T;
    const book = new MessageFilesBook(() => now);
    recordRunFiles(book, [say(C1, "amy", "a1", T, [{ name: "a.png" }])]);
    now = T + KEEP_MS - 1;
    expect(names(book, C1, "a1")).toEqual(["a.png"]);
    now = T + KEEP_MS + 1;
    expect(names(book, C1, "a1")).toEqual([]);
    const crowd = new MessageFilesBook(() => T);
    for (let i = 0; i < MAX_MESSAGES + 10; i++) {
      recordRunFiles(crowd, [say(C1, `u${i}`, `m${i}`, T, [{ name: `${i}.txt` }])]);
    }
    expect(names(crowd, C1, "m0")).toEqual([]);
    expect(names(crowd, C1, `m${MAX_MESSAGES + 9}`)).toEqual([`${MAX_MESSAGES + 9}.txt`]);
    expect(names(crowd, C1, "m10")).toEqual(["10.txt"]);
  });
});
