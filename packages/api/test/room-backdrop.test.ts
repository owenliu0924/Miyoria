// The picture behind her in the room: how it is named, re-read and refused, and who may fetch it.
// The pictures here are made-up bytes; nothing looks at what is in them.

import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOM_BACKDROP_PATH } from "@miyoria/contracts/api";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKDROP_MAX_BYTES, backdropPath, RoomBackdrop } from "../src/room/backdrop.js";
import { RoomConfigSchema } from "../src/room/config.js";
import { FIGURE_IMMUTABLE } from "../src/room/figure.js";
import { roomRoutes } from "../src/room/routes.js";
import { roomStateOf } from "../src/room/state.js";
import { ALICE, appOf, makeRig } from "./room-rig.js";

let root = "";
const hashOf = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex").slice(0, 20);
const bytesOf = (n: number, fill: number) => new Uint8Array(n).fill(fill);

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "miyoria-backdrop-"));
  mkdirSync(join(root, "a"));
  writeFileSync(join(root, "a", "one.webp"), bytesOf(300, 5));
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

function logOf() {
  const lines: string[] = [];
  return {
    lines,
    log: {
      info: (_: object, msg: string) => lines.push(`info: ${msg}`),
      warn: (_: object, msg: string) => lines.push(`warn: ${msg}`),
    },
  };
}

function backdrop(path: string, clock = { t: 0 }) {
  const l = logOf();
  const b = new RoomBackdrop({ path, log: l.log, now: () => clock.t, recheckMs: 1000 });
  return { b, clock, lines: l.lines };
}

/** Lets the re-check, which runs in the background, finish. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 50));

describe("her room's backdrop", () => {
  it("is named by its content's hash, and served with the headers of a file that never changes", async () => {
    const data = bytesOf(300, 5);
    const path = join(root, "a", "one.webp");
    const { b } = backdrop(path);
    await b.prepare();
    const name = `backdrop-${hashOf(data)}.webp`;
    expect(b.state()).toEqual({ image: `${ROOM_BACKDROP_PATH}/${name}` });
    const res = b.file(name);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe(FIGURE_IMMUTABLE);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(data);
    expect(() => b.file(`backdrop-${"0".repeat(20)}.webp`)).toThrow();
    expect(() => b.file("../one.webp")).toThrow();
  });

  it("takes each kind of image with its own content type", async () => {
    const types: Record<string, string> = {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      avif: "image/avif",
    };
    for (const [ext, type] of Object.entries(types)) {
      const path = join(root, "a", `kind.${ext}`);
      writeFileSync(path, bytesOf(20, 9));
      const { b } = backdrop(path);
      await b.prepare();
      const image = b.state()?.image ?? "";
      expect(image).toMatch(new RegExp(`/backdrop-[0-9a-f]{20}\\.${ext}$`));
      expect(b.file(image.split("/").pop() as string).headers.get("content-type")).toBe(type);
    }
  });

  it("picks up a replaced file after the re-check interval, and only then", async () => {
    const path = join(root, "a", "swap.png");
    writeFileSync(path, bytesOf(100, 1));
    const { b, clock } = backdrop(path);
    await b.prepare();
    const first = b.state()?.image;
    writeFileSync(path, bytesOf(120, 2));
    clock.t = 500;
    expect(b.state()?.image).toBe(first);
    await settle();
    expect(b.state()?.image).toBe(first);
    clock.t = 1500;
    b.state();
    await settle();
    const second = b.state()?.image;
    expect(second).toBeDefined();
    expect(second).not.toBe(first);
    // The old name is gone with the old picture.
    expect(() => b.file(String(first).split("/").pop() as string)).toThrow();
    expect(b.file(String(second).split("/").pop() as string).status).toBe(200);
  });

  it("notices a replacement of the same size by its time", async () => {
    const path = join(root, "a", "same.png");
    writeFileSync(path, bytesOf(100, 1));
    utimesSync(path, 1000, 1000);
    const { b, clock } = backdrop(path);
    await b.prepare();
    const first = b.state()?.image;
    writeFileSync(path, bytesOf(100, 2));
    utimesSync(path, 2000, 2000);
    clock.t = 2000;
    b.state();
    await settle();
    expect(b.state()?.image).not.toBe(first);
  });

  it("is none, said once, when the file is missing, not a file, the wrong kind or too large", async () => {
    const cases: [string, () => string][] = [
      ["does not exist", () => join(root, "a", "missing.png")],
      ["is not a file", () => join(root, "a")],
      [
        "is not .webp",
        () => {
          const p = join(root, "a", "notes.gif");
          writeFileSync(p, bytesOf(10, 1));
          return p;
        },
      ],
      [
        "larger than 12 MB",
        () => {
          const p = join(root, "a", "huge.jpg");
          writeFileSync(p, bytesOf(BACKDROP_MAX_BYTES + 1, 1));
          return p;
        },
      ],
    ];
    for (const [why, make] of cases) {
      const path = make();
      const { b, lines } = backdrop(path);
      await b.prepare();
      await b.prepare();
      expect(b.state()).toBeNull();
      expect(() => b.file("backdrop-00000000000000000000.png")).toThrow();
      expect(lines).toHaveLength(1);
      expect(lines[0]).toContain(why);
      expect(lines[0]?.startsWith("warn")).toBe(true);
    }
  });

  it("is none for an empty path, silently, and resolves a set one against the working folder", async () => {
    const { b, lines } = backdrop("");
    await b.prepare();
    expect(b.state()).toBeNull();
    expect(lines).toEqual([]);
    expect(backdropPath(RoomConfigSchema.parse({}), "/srv/core")).toBe("");
    expect(
      backdropPath(RoomConfigSchema.parse({ backdrop: "pics/her.webp" }), "/srv/core"),
    ).toMatch(/pics[\\/]her\.webp$/);
  });

  it("comes back when a missing file appears", async () => {
    const path = join(root, "a", "later.webp");
    const { b, clock } = backdrop(path);
    await b.prepare();
    expect(b.state()).toBeNull();
    writeFileSync(path, bytesOf(50, 3));
    clock.t = 5000;
    b.state();
    await settle();
    expect(b.state()).not.toBeNull();
  });
});

describe("her room's backdrop routes and state", () => {
  async function rig(path: string) {
    const r = makeRig();
    const b = new RoomBackdrop({ path, log: logOf().log });
    await b.prepare();
    r.room.backdrop = b;
    const app = appOf(roomRoutes(r.state as never), { account: ALICE });
    return { ...r, b, app };
  }
  const who = {
    member: { account: ALICE, person: null, row: null, hidden: false },
    blocked: false,
    open: true,
  };

  it("is a member route, for a session only", async () => {
    const r = await rig(join(root, "a", "one.webp"));
    const routes = roomRoutes(r.state as never).filter((x) => x.path.includes("/backdrop"));
    expect(routes.map((x) => `${x.method} ${x.path}`)).toEqual([`GET ${ROOM_BACKDROP_PATH}/:name`]);
    expect(routes.every((x) => x.member === true)).toBe(true);
  });

  it("gives the picture under its current name to someone the room is open to, and a 404 otherwise", async () => {
    const r = await rig(join(root, "a", "one.webp"));
    const url = r.b.state()?.image as string;
    const res = await r.app.request(url);
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/webp");
    expect(res.headers.get("cache-control")).toBe(FIGURE_IMMUTABLE);
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    await res.arrayBuffer();
    expect(
      (await r.app.request(`${ROOM_BACKDROP_PATH}/backdrop-${"0".repeat(20)}.webp`)).status,
    ).toBe(404);
    expect((await r.app.request(`${ROOM_BACKDROP_PATH}/one.webp`)).status).toBe(404);
    r.blocked.add(ALICE.id);
    expect((await r.app.request(url)).status).toBe(404);
  });

  it("is a 404 while no backdrop is set, and counts on the figure files' window", async () => {
    const r = makeRig();
    const app = appOf(roomRoutes(r.state as never), { account: ALICE });
    expect(
      (await app.request(`${ROOM_BACKDROP_PATH}/backdrop-${"0".repeat(20)}.webp`)).status,
    ).toBe(404);
    const withOne = await rig(join(root, "a", "one.webp"));
    const url = withOne.b.state()?.image as string;
    let last = 0;
    for (let i = 0; i < 241; i++) {
      const res = await withOne.app.request(url);
      last = res.status;
      await res.arrayBuffer();
    }
    expect(last).toBe(429);
  });

  it("puts the picture in the room's state only for someone the room is open to", async () => {
    const r = await rig(join(root, "a", "one.webp"));
    expect(roomStateOf(r.state as never, r.room, who as never).backdrop?.image).toMatch(
      new RegExp(`^${ROOM_BACKDROP_PATH}/backdrop-[0-9a-f]{20}\\.webp$`),
    );
    expect(
      roomStateOf(r.state as never, r.room, { ...who, blocked: true } as never).backdrop,
    ).toBeNull();
    expect(
      roomStateOf(r.state as never, r.room, { ...who, open: false } as never).backdrop,
    ).toBeNull();
    r.room.backdrop = null;
    expect(roomStateOf(r.state as never, r.room, who as never).backdrop).toBeNull();
  });
});
