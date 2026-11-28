import type { RoomBacklog, RoomEvent, RoomRelation, RoomSendResult, RoomState, RoomUpload } from "@miyoria/contracts/api";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiError } from "@/api/http";
import type { HerFigure } from "./figure";
import type { RoomApi } from "./room-api";
import { roomState } from "./room-fixtures";
import { Room } from "./RoomPage";

const MB = 1024 * 1024;

function reducedMotion(on: boolean) {
  vi.stubGlobal("matchMedia", (query: string) => ({
    matches: on && query.includes("reduce"),
    media: query,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
}

const figure = (): HerFigure => ({ mount() {}, show() {}, speaking() {}, dispose() {} });

interface Fake {
  api: RoomApi;
  emit: (event: RoomEvent, id?: string | null) => void;
  /** The stream ends (the server closed it); the page reconnects. */
  drop: () => void;
  follows: Array<{ lastEventId: string | null }>;
  resolveUpload: (upload: RoomUpload) => void;
}

function fake(opts: { state?: RoomState; backlog?: RoomBacklog | ((older: string | null) => RoomBacklog); relation?: RoomRelation; send?: RoomApi["send"] } = {}): Fake {
  let current: ((e: RoomEvent, id: string | null) => void) | null = null;
  let end: (() => void) | null = null;
  const follows: Fake["follows"] = [];
  let uploadDone: ((u: RoomUpload) => void) | null = null;
  let n = 0;
  const api: RoomApi = {
    state: vi.fn(async () => opts.state ?? roomState()),
    backlog: vi.fn(async (older: string | null) =>
      typeof opts.backlog === "function" ? opts.backlog(older) : (opts.backlog ?? { entries: [], older: null }),
    ),
    relation: vi.fn(async () => opts.relation ?? { bond: null, feeling: null, memories: [] }),
    send:
      opts.send ??
      vi.fn(async (): Promise<RoomSendResult> => ({ id: `L${++n}`, at: "2026-11-28T12:00:00Z", heard: "ok", notice: null })),
    upload: vi.fn(
      (_file: File, _signal?: AbortSignal, onProgress?: (sent: number) => void) =>
        new Promise<RoomUpload>((resolve) => {
          onProgress?.(0.5);
          uploadDone = resolve;
        }),
    ),
    forgetMemory: vi.fn(async () => ({ forgotten: true })),
    excludeLine: vi.fn(async () => ({ excluded: true })),
    voice: vi.fn(async () => new Blob()),
    file: vi.fn(async () => ({ blob: new Blob(), name: "a.txt" })),
    follow: vi.fn(
      ({ lastEventId, signal, onEvent }: Parameters<RoomApi["follow"]>[0]) =>
        new Promise<void>((resolve) => {
          follows.push({ lastEventId });
          current = onEvent;
          end = () => {
            current = null;
            resolve();
          };
          signal.addEventListener("abort", () => resolve(), { once: true });
        }),
    ),
  };
  return {
    api,
    follows,
    emit: (event, id = null) => act(() => current?.(event, id)),
    drop: () => act(() => end?.()),
    resolveUpload: (u) => act(() => uploadDone?.(u)),
  };
}

function show(f: Fake) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <Room api={f.api} member={{ name: "小澄", avatar_url: null }} home="/" figure={figure} tab="test-tab" />
    </QueryClientProvider>,
  );
}

const at = "2026-11-28T12:00:00Z";
const herLine = (id: string, text: string, turn: string | null = "t1"): RoomEvent => ({ kind: "line", id, at, turn, text, files: [], voice: false });

// jsdom has no PointerEvent: a mouse event with a pointer id stands in for it.
if (typeof window.PointerEvent === "undefined") {
  class PointerEventStub extends MouseEvent {
    readonly pointerId: number;
    readonly pointerType: string;
    constructor(type: string, init: PointerEventInit = {}) {
      super(type, init);
      this.pointerId = init.pointerId ?? 1;
      this.pointerType = init.pointerType ?? "touch";
    }
  }
  window.PointerEvent = PointerEventStub as unknown as typeof PointerEvent;
}

beforeEach(() => reducedMotion(true));
afterEach(() => vi.unstubAllGlobals());

describe("her room", () => {
  it("shows her thinking, then her reply a step at a time, and announces each step once", async () => {
    const f = fake();
    show(f);
    const say = await screen.findByRole("textbox", { name: "跟她說的話" });
    f.emit({ kind: "hello", state: roomState(), turn: null });
    f.emit({ kind: "thinking", turn: "t1" });
    expect(screen.getAllByText("她在想").length).toBeGreaterThan(0);
    f.emit({ kind: "step", turn: "t1", label: "查資料", state: "started" });
    expect(screen.getAllByText("她在查資料").length).toBeGreaterThan(0);
    f.emit(herLine("a", "……欸?你真的記得喔。"));
    f.emit({ kind: "typing" });
    f.emit(herLine("b", "哼,算你記性好。"));
    expect(screen.getByText("……欸?你真的記得喔。")).toBeInTheDocument();
    expect(screen.getByText("她說:……欸?你真的記得喔。")).toBeInTheDocument();
    // Enter in the empty capsule steps on; so does the line itself (a button while there is more).
    const next = screen.getByRole("button", { name: "下一句" });
    expect(next).toHaveAttribute("title", "下一句(Enter)");
    say.focus();
    fireEvent.keyDown(say, { key: "Enter" });
    expect(screen.getByText("哼,算你記性好。")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "下一句" })).toBeNull();
    expect(screen.getByText("她說:哼,算你記性好。")).toBeInTheDocument();
  });

  it("types her line in a little at a time, and a press shows it whole", async () => {
    reducedMotion(false);
    const f = fake();
    show(f);
    await screen.findByRole("textbox", { name: "跟她說的話" });
    f.emit(herLine("a", "一二三四五六七八九十"));
    f.emit(herLine("b", "下一句"));
    const her = document.querySelector(".hr-her") as HTMLElement;
    expect(her.textContent).toBe("");
    await waitFor(() => expect(her.textContent?.length).toBeGreaterThan(0));
    expect(her.textContent).not.toBe("一二三四五六七八九十");
    // The live region already has the whole line: no character-by-character announcements.
    expect(screen.getByText("她說:一二三四五六七八九十")).toBeInTheDocument();
    fireEvent.click(her);
    expect(her.textContent).toBe("一二三四五六七八九十");
    fireEvent.click(her);
    await waitFor(() => expect(her.textContent).toBe("下一句"));
  });

  it("sends at once with the member's line on the stage, and the echo from the stream is not doubled", async () => {
    const f = fake();
    show(f);
    const say = await screen.findByRole("textbox", { name: "跟她說的話" });
    await userEvent.type(say, "晚安{Enter}");
    expect(say).toHaveValue("");
    expect(screen.getByText("你:晚安")).toBeInTheDocument();
    await waitFor(() => expect(f.api.send).toHaveBeenCalledTimes(1));
    const request = vi.mocked(f.api.send).mock.calls[0]?.[0];
    expect(request).toMatchObject({ text: "晚安", uploads: [] });
    expect(request?.client_id).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    f.emit({ kind: "you", id: "L1", at, text: "晚安", files: [], client_id: request?.client_id ?? null });
    expect(screen.getAllByText("你:晚安")).toHaveLength(1);
    // Her emoji answer goes beside it.
    f.emit({ kind: "reaction", to: "L1", emoji: "🌙" });
    expect(screen.getByText("你:晚安 🌙")).toBeInTheDocument();
  });

  it("keeps the words and says why when a send does not go: she is not there, too fast, offline", async () => {
    const errors = [
      new ApiError("unavailable", 503, "/api/member/room/messages", "她現在不在"),
      new ApiError("http", 429, "/api/member/room/messages", "你說得太快了,等一下再說"),
      new ApiError("network", 0, "/api/member/room/messages", "Failed to fetch"),
    ];
    const send = vi.fn(async () => {
      throw errors.shift();
    });
    const f = fake({ send });
    show(f);
    const say = await screen.findByRole("textbox", { name: "跟她說的話" });
    await userEvent.type(say, "在嗎{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("她現在不在");
    expect(say).toHaveValue("在嗎");
    expect(screen.queryByText("你:在嗎")).toBeNull();
    await userEvent.type(say, "{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("你說得太快了,等一下再說");
    await userEvent.type(say, "{Enter}");
    expect(await screen.findByRole("alert")).toHaveTextContent("連不上她的房間,沒有送出");
    expect(say).toHaveValue("在嗎");
  });

  it("says moderation's fixed line when she will not take it up", async () => {
    const send = vi.fn(async (): Promise<RoomSendResult> => ({ id: "L1", at, heard: "ignored", notice: "這句她收不到" }));
    const f = fake({ send });
    show(f);
    const say = await screen.findByRole("textbox", { name: "跟她說的話" });
    await userEvent.type(say, "……{Enter}");
    expect(await screen.findByText("這句她收不到")).toBeInTheDocument();
  });

  it("says when she can answer again once their quota is reached, and that she keeps words while paused", async () => {
    const until = new Date(2026, 10, 28, 21, 5).toISOString();
    show(fake({ state: roomState({ quota: { capped: "day", until } }) }));
    expect(await screen.findByPlaceholderText("她晚點才能回你(21:05)")).toBeInTheDocument();
  });

  it("while she is paused the capsule still takes words", async () => {
    show(fake({ state: roomState({ paused: true }) }));
    expect(await screen.findByPlaceholderText("她現在暫停中,你說的她會記得")).toBeInTheDocument();
    expect(screen.getByText("她現在暫停中")).toBeInTheDocument();
  });

  it("while she is busy singing it says so, and promises nothing about her answers", async () => {
    const f = fake({ state: roomState({ doing: "singing", detail: "晴天", watch: true }) });
    show(f);
    const say = await screen.findByPlaceholderText("跟她說點什麼");
    expect(screen.getByText("在唱〈晴天〉")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "去聽" })).toHaveAttribute("href", "/watch");
    expect(document.body.textContent).not.toContain("簡短");
    // A line while she is still answering the last one: taken, and her reply goes on.
    f.emit({ kind: "thinking", turn: "t1" });
    await userEvent.type(say, "還有一件事{Enter}");
    expect(screen.getByText("你:還有一件事")).toBeInTheDocument();
    expect(screen.getAllByText("她在想").length).toBeGreaterThan(0);
  });

  it("shows only her and the reason when the room is closed to them", async () => {
    show(fake({ state: roomState({ open: false, closed: "她的房間現在沒有對你開放" }) }));
    expect(await screen.findByText("她的房間現在沒有對你開放")).toBeInTheDocument();
    expect(screen.queryByRole("textbox")).toBeNull();
    expect(screen.queryByRole("button", { name: /你們/ })).toBeNull();
  });

  it("says the room is not there on a Core without it", async () => {
    const f = fake();
    vi.mocked(f.api.state).mockRejectedValue(new ApiError("not_provided", 404, "/api/member/room", "no such endpoint"));
    show(f);
    expect(await screen.findByText("她的房間現在沒有開")).toBeInTheDocument();
  });

  it("says the link is lost while it reconnects, and reads the backlog again after a reset", async () => {
    const f = fake();
    show(f);
    await screen.findByRole("textbox", { name: "跟她說的話" });
    f.emit({ kind: "hello", state: roomState(), turn: null }, "run-1");
    f.drop();
    expect(await screen.findByText("連線中斷,正在重新連上")).toBeInTheDocument();
    await waitFor(() => expect(f.follows).toHaveLength(2), { timeout: 3000 });
    expect(f.follows[1]?.lastEventId).toBe("run-1");
    const before = vi.mocked(f.api.backlog).mock.calls.length;
    f.emit({ kind: "hello", state: roomState(), turn: null });
    f.emit({ kind: "reset" });
    await waitFor(() => expect(vi.mocked(f.api.backlog).mock.calls.length).toBe(before + 1));
    expect(screen.queryByText("連線中斷,正在重新連上")).toBeNull();
  });

  it("shows a bond change as a direction and her quote", async () => {
    const f = fake();
    show(f);
    await screen.findByRole("textbox", { name: "跟她說的話" });
    f.emit({ kind: "bond", id: "B1", at, turn: "t1", sign: "plus", quote: "記得答應我的事" });
    const corner = screen.getByRole("region", { name: "羈絆" });
    expect(within(corner).getByText("+")).toBeInTheDocument();
    expect(within(corner).getByText("記得答應我的事")).toBeInTheDocument();
    expect(within(corner).queryByText(/\d/)).toBeNull();
  });

  it("greys her voice with the Core's reason", async () => {
    show(fake({ state: roomState({ voice: { available: false, reason: "聲音借給唱歌了,唱完就好" } }) }));
    const key = await screen.findByRole("button", { name: "她的聲音" });
    expect(key).toHaveAttribute("aria-disabled", "true");
    expect(key).toHaveAttribute("title", "聲音借給唱歌了,唱完就好");
    expect(key).toHaveAccessibleDescription("聲音借給唱歌了,唱完就好");
  });
});

describe("the backlog", () => {
  const page = (from: number, to: number) =>
    Array.from({ length: to - from }, (_, i) => ({
      type: "line" as const,
      id: `E${from + i}`,
      at,
      who: (from + i) % 2 === 0 ? ("you" as const) : ("her" as const),
      text: `第 ${from + i} 句`,
      files: [],
    }));

  it("opens with PageUp, focus on 關閉, pages back, and closes with Escape back to 紀錄", async () => {
    const f = fake({ backlog: (older) => (older === null ? { entries: page(10, 20), older: "c10" } : { entries: page(0, 10), older: null }) });
    show(f);
    await screen.findByRole("textbox", { name: "跟她說的話" });
    fireEvent.keyDown(document, { key: "PageUp" });
    const dialog = await screen.findByRole("dialog", { name: "紀錄" });
    expect(within(dialog).getByRole("button", { name: "關閉" })).toHaveFocus();
    expect(within(dialog).getByText("第 19 句")).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "更早的" }));
    expect(await within(dialog).findByText("第 0 句")).toBeInTheDocument();
    expect(within(dialog).queryByRole("button", { name: "更早的" })).toBeNull();
    expect(within(dialog).getByText(/她是 AI 角色/)).toBeInTheDocument();
    fireEvent.keyDown(within(dialog).getByRole("button", { name: "關閉" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "紀錄" })).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "紀錄" })).toHaveFocus());
  });

  it("opens with a swipe up from the capsule and closes with a swipe down on its head", async () => {
    show(fake());
    await screen.findByRole("textbox", { name: "跟她說的話" });
    const dock = document.querySelector(".hr-dock") as HTMLElement;
    const handle = dock.querySelector(".hr-handle") as HTMLElement;
    fireEvent.pointerDown(handle, { pointerId: 1, clientX: 100, clientY: 700, button: 0 });
    fireEvent.pointerMove(dock, { pointerId: 1, clientX: 100, clientY: 620 });
    fireEvent.pointerUp(dock, { pointerId: 1, clientX: 100, clientY: 620 });
    const dialog = await screen.findByRole("dialog", { name: "紀錄" });
    const head = dialog.querySelector(".hr-bl-head") as HTMLElement;
    fireEvent.pointerDown(head, { pointerId: 2, clientX: 100, clientY: 100, button: 0 });
    fireEvent.pointerMove(head, { pointerId: 2, clientX: 100, clientY: 200 });
    fireEvent.pointerUp(head, { pointerId: 2, clientX: 100, clientY: 200 });
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "紀錄" })).toBeNull());
  });

  it("lets them take back their own line after one confirmation", async () => {
    const f = fake({ backlog: { entries: page(0, 2), older: null } });
    show(f);
    await screen.findByRole("textbox", { name: "跟她說的話" });
    await userEvent.click(screen.getByRole("button", { name: "紀錄" }));
    const dialog = await screen.findByRole("dialog", { name: "紀錄" });
    // Only their own line has it.
    expect(within(dialog).getAllByRole("button", { name: "不要記住這句" })).toHaveLength(1);
    await userEvent.click(within(dialog).getByRole("button", { name: "不要記住這句" }));
    expect(within(dialog).getByText(/不能復原/)).toBeInTheDocument();
    await userEvent.click(within(dialog).getByRole("button", { name: "不要記住" }));
    await waitFor(() => expect(within(dialog).queryByText("第 0 句")).toBeNull());
    expect(f.api.excludeLine).toHaveBeenCalledWith("E0");
    // The button that had focus left with the line: focus stays in the dialog, so Escape closes it.
    await waitFor(() => expect(within(dialog).getByRole("button", { name: "關閉" })).toHaveFocus());
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "紀錄" })).toBeNull());
  });
});

describe("attachments", () => {
  const pick = (files: File[]) => {
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    fireEvent.change(input, { target: { files } });
  };
  const sized = (name: string, size: number, type: string) => {
    const file = new File(["x"], name, { type });
    Object.defineProperty(file, "size", { value: size });
    return file;
  };

  it("refuses files over the limits with the Core's words, uploads the rest with progress, and sends their ids", async () => {
    const f = fake();
    show(f);
    const say = await screen.findByRole("textbox", { name: "跟她說的話" });
    pick([sized("大.png", 6 * MB, "image/png")]);
    expect(await screen.findByRole("alert")).toHaveTextContent("檔案太大了(圖片最多 5 MB,其他最多 8 MB)");
    expect(f.api.upload).not.toHaveBeenCalled();

    pick([sized("菜單.pdf", 200 * 1024, "application/pdf")]);
    const chips = await screen.findByRole("list", { name: "附加的檔案" });
    expect(within(chips).getByRole("progressbar", { name: "菜單.pdf 上傳中" })).toHaveAttribute("aria-valuenow", "50");
    // Not yet: the file is still going up.
    await userEvent.type(say, "看一下{Enter}");
    expect(f.api.send).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "送出" })).toHaveAttribute("title", "檔案還在傳");

    f.resolveUpload({ id: "up_AAAAAAAAAAAAAAAAAAAAAA", name: "菜單.pdf", size: 204800, kind: "file", expires_at: at });
    await userEvent.type(say, "{Enter}");
    await waitFor(() => expect(f.api.send).toHaveBeenCalledTimes(1));
    expect(vi.mocked(f.api.send).mock.calls[0]?.[0]).toMatchObject({ text: "看一下", uploads: ["up_AAAAAAAAAAAAAAAAAAAAAA"] });
    expect(screen.queryByRole("list", { name: "附加的檔案" })).toBeNull();
    expect(screen.getByText("你:看一下 · 菜單.pdf")).toBeInTheDocument();
  });

  it("stops at the most files a line may carry", async () => {
    show(fake());
    await screen.findByRole("textbox", { name: "跟她說的話" });
    pick([1, 2, 3, 4, 5].map((i) => sized(`${i}.txt`, 10, "text/plain")));
    const chips = await screen.findByRole("list", { name: "附加的檔案" });
    expect(within(chips).getAllByRole("listitem")).toHaveLength(4);
    expect(screen.getByRole("alert")).toHaveTextContent("一句最多附 4 個檔案");
    await userEvent.click(within(chips).getByRole("button", { name: "拿掉 1.txt" }));
    expect(within(chips).getAllByRole("listitem")).toHaveLength(3);
  });
});

describe("her words about them", () => {
  const relation: RoomRelation = {
    bond: {
      tier: "心有靈犀",
      stage: 2,
      tier_label: "心有靈犀 II",
      next_tier: "心有靈犀",
      next_label: "心有靈犀 III",
      tier_progress: 0.4,
      ring: { lap: 3, fraction: 0.4, full: false },
    },
    feeling: "答應的事都會做到。",
    memories: [{ id: "m1", text: "你陪我練〈晴天〉", kind: "episode", date: "2026-11-02" }],
  };

  it("opens from the ring, asks about a memory into the capsule, forgets one after a confirmation", async () => {
    const f = fake({ relation });
    show(f);
    const say = await screen.findByRole("textbox", { name: "跟她說的話" });
    const ring = await screen.findByRole("button", { name: "你們:心有靈犀 II" });
    await userEvent.click(ring);
    const panel = await screen.findByRole("dialog", { name: "心有靈犀 II" });
    expect(within(panel).getByRole("button", { name: "關閉" })).toHaveFocus();
    expect(within(panel).getByText("離「心有靈犀 III」還有一段")).toBeInTheDocument();
    expect(within(panel).getByText("答應的事都會做到。")).toBeInTheDocument();

    const memory = within(panel).getByRole("button", { name: /你陪我練〈晴天〉/ });
    await userEvent.click(memory);
    expect(memory).toHaveAttribute("aria-expanded", "true");
    await userEvent.click(within(panel).getByRole("button", { name: "請她忘掉" }));
    expect(within(panel).getByText("她會忘掉這件事,不能復原。你們的羈絆不會因此改變。")).toBeInTheDocument();
    await userEvent.click(within(panel).getByRole("button", { name: "忘掉" }));
    expect(await within(panel).findByText("她忘掉了一件事")).toBeInTheDocument();
    expect(f.api.forgetMemory).toHaveBeenCalledWith("m1");

    fireEvent.keyDown(within(panel).getByRole("button", { name: "關閉" }), { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    await waitFor(() => expect(screen.getByRole("button", { name: "你們:心有靈犀 II" })).toHaveFocus());

    await userEvent.click(screen.getByRole("button", { name: "你們:心有靈犀 II" }));
    const again = await screen.findByRole("dialog", { name: "心有靈犀 II" });
    await userEvent.click(within(again).getByRole("button", { name: /你陪我練〈晴天〉/ }));
    await userEvent.click(within(again).getByRole("button", { name: "問她這件事" }));
    await waitFor(() => expect(say).toHaveValue("還記得「你陪我練〈晴天〉」嗎?"));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
