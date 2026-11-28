// What people attach in her room (docs/design/her-room.md §3.3): memory only, an id of 128 random
// bits, one line per upload and only its owner's, 30 minutes unsent and 30 more once sent, and the
// `.invalid` URL that only this service answers (never `http://`, another host or a query).

import type { RoomUpload } from "@miyoria/contracts/api";
import { type AccountRef, IncomingFilesKey, incomingAllowed, incomingFetch } from "@miyoria/types";
import { describe, expect, it } from "vitest";
import { RoomUploads, SENT_MS, UNSENT_MS, uploadIdOf, uploadUrl } from "../src/room/uploads.js";

const ALICE: AccountRef = { platform: "discord", id: "1" };
const BOB: AccountRef = { platform: "discord", id: "2" };
const T0 = Date.UTC(2026, 10, 28, 4, 0, 0);
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
const TEXT = new TextEncoder().encode("hello, file");
const init = () => ({ signal: new AbortController().signal, redirect: "error" as const });

function uploads(pool = 1_000_000) {
  const clock = { t: T0 };
  let draws = 0;
  const random = (n: number) => {
    draws += 1;
    return new Uint8Array(n).fill(draws);
  };
  return { clock, uploads: new RoomUploads(() => clock.t, pool, random) };
}

function put(u: RoomUploads, account: AccountRef, bytes: Uint8Array, name = "a.txt"): RoomUpload {
  const kept = u.put(account, encodeURIComponent(name), "text/plain; charset=utf-8", bytes);
  if (kept === "full") throw new Error("full");
  return kept;
}

describe("the room's uploads", () => {
  it("gives an id of up_ and 22 characters, and says what it kept", () => {
    const { uploads: u } = uploads();
    const a = put(u, ALICE, TEXT, "筆記 ../x.txt");
    const b = put(u, ALICE, PNG, "cat.png");
    expect(a.id).toMatch(/^up_[A-Za-z0-9_-]{22}$/);
    expect(b.id).toMatch(/^up_[A-Za-z0-9_-]{22}$/);
    expect(a.id).not.toBe(b.id);
    expect(a).toMatchObject({ size: TEXT.byteLength, kind: "file" });
    // The kind is the bytes', not the name's or the browser's word.
    expect(b).toMatchObject({ kind: "image", size: PNG.byteLength });
    expect(a.name).not.toContain("/");
    expect(Date.parse(a.expires_at)).toBe(T0 + UNSENT_MS);
    expect(u.total).toBe(TEXT.byteLength + PNG.byteLength);
  });

  it("is taken once, by its owner only, while it lasts", () => {
    const { uploads: u, clock } = uploads();
    const a = put(u, ALICE, TEXT);
    expect(u.take(BOB, [a.id])).toBeNull();
    expect(u.take(ALICE, ["up_AAAAAAAAAAAAAAAAAAAAAA"])).toBeNull();
    const taken = u.take(ALICE, [a.id, a.id]);
    expect(taken).toEqual([
      {
        id: a.id,
        url: `https://uploads.room.invalid/${a.id}`,
        name: a.name,
        type: "text/plain",
        kind: "file",
        size: TEXT.byteLength,
      },
    ]);
    // Each upload goes with one line.
    expect(u.take(ALICE, [a.id])).toBeNull();
    // One not theirs spoils the whole line: nothing of it is taken.
    const b = put(u, ALICE, TEXT);
    const c = put(u, BOB, TEXT);
    expect(u.take(ALICE, [b.id, c.id])).toBeNull();
    expect(u.take(ALICE, [b.id])).not.toBeNull();
    // Unsent for 30 minutes: gone.
    const d = put(u, ALICE, TEXT);
    clock.t += UNSENT_MS - 1;
    const e = put(u, ALICE, TEXT);
    clock.t += 1;
    expect(u.take(ALICE, [d.id])).toBeNull();
    expect(u.take(ALICE, [e.id])).not.toBeNull();
  });

  it("answers only its own sent files' URLs", async () => {
    const { uploads: u, clock } = uploads();
    const a = put(u, ALICE, PNG, "cat.png");
    const url = uploadUrl(a.id);
    // Nobody's file until a line takes it.
    expect(u.handles(url)).toBe(false);
    expect((await u.fetch(url, init())).status).toBe(404);
    u.take(ALICE, [a.id]);
    expect(u.handles(url)).toBe(true);
    for (const other of [
      `http://uploads.room.invalid/${a.id}`,
      `https://uploads.room.example/${a.id}`,
      `https://cdn.discordapp.com/${a.id}`,
      `${url}?size=1`,
      `${url}#x`,
      `${url}/more`,
      "https://uploads.room.invalid/up_short",
      "not a url",
    ]) {
      expect(u.handles(other), other).toBe(false);
      expect(uploadIdOf(other), other).toBeNull();
    }
    const res = await u.fetch(url, init());
    expect(res.status).toBe(200);
    expect(res.headers.get("content-length")).toBe(String(PNG.byteLength));
    expect(res.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(PNG);
    // Through the downloaders' helpers: the service answers, the network is never asked.
    const services = { get: <T>(key: unknown) => (key === IncomingFilesKey ? u : undefined) as T };
    expect(incomingAllowed(services, url)).toBe(true);
    expect(incomingAllowed(services, `http://uploads.room.invalid/${a.id}`)).toBe(false);
    const network: string[] = [];
    const fetched = incomingFetch(services, async (to) => {
      network.push(to);
      return new Response("elsewhere");
    });
    expect((await fetched(url, init())).status).toBe(200);
    expect(
      (await fetched("https://uploads.room.invalid/up_BBBBBBBBBBBBBBBBBBBBBB", init())).status,
    ).toBe(404);
    expect(network).toEqual([]);
    // A sent file is kept 30 minutes more, then dropped.
    clock.t += SENT_MS - 1;
    expect(u.handles(url)).toBe(true);
    clock.t += 1;
    expect(u.handles(url)).toBe(false);
    expect((await u.fetch(url, init())).status).toBe(404);
    expect(u.total).toBe(0);
  });

  it("refuses an aborted fetch", async () => {
    const { uploads: u } = uploads();
    const a = put(u, ALICE, TEXT);
    u.take(ALICE, [a.id]);
    const ctl = new AbortController();
    ctl.abort();
    await expect(
      u.fetch(uploadUrl(a.id), { signal: ctl.signal, redirect: "error" }),
    ).rejects.toThrow();
  });

  it("is full when the pool would pass its limit, and frees what expired", () => {
    const { uploads: u, clock } = uploads(20);
    put(u, ALICE, TEXT);
    expect(u.put(BOB, "b.txt", undefined, TEXT)).toBe("full");
    expect(u.put(BOB, "b.txt", undefined, new Uint8Array(20 - TEXT.byteLength))).not.toBe("full");
    expect(u.put(BOB, "c.txt", undefined, new Uint8Array(1))).toBe("full");
    clock.t += UNSENT_MS;
    expect(u.put(BOB, "b.txt", undefined, TEXT)).not.toBe("full");
    u.clear();
    expect(u.total).toBe(0);
  });
});
