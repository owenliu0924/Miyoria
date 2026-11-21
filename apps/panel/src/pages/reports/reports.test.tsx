import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { ReportDraftView, ReportList } from "@miyoria/contracts/api";
import { mockFetch, renderRoute } from "@/test/render";
import { parseIssue } from "./labels";

const iso = (agoMs: number) => new Date(Date.now() - agoMs).toISOString();

const draft = (id: string, over: Partial<ReportDraftView> = {}): ReportDraftView => ({
  id,
  status: "draft",
  area: "voice",
  title: "語音頻道裡她聽不到人說話",
  happened: "講話她都沒有反應",
  expected: "她聽得到",
  steps: null,
  person_id: "p-1",
  place: "channel",
  created_at: iso(3_600_000),
  likely_duplicate: null,
  issue_title: "[voice] 語音頻道裡她聽不到人說話",
  issue_body: "### 發生了什麼\n\n講話她都沒有反應",
  comment_body: "另一位成員回報了看起來相同的問題",
  issue: null,
  decided_by: null,
  decided_at: null,
  reason: null,
  last_error: null,
  closed_at: null,
  close_reason: null,
  notified_at: null,
  ...over,
});

const list = (drafts: ReportDraftView[], over: Partial<ReportList> = {}): ReportList => ({
  repo: "owner/repo",
  ready: true,
  auto_open: false,
  per_person_daily: 3,
  global_daily: 20,
  today: drafts.length,
  drafts,
  ...over,
});

const posts = (fetch: ReturnType<typeof mockFetch>) =>
  fetch.mock.calls
    .filter(([, init]) => init?.method === "POST")
    .map(([u, init]) => [new URL(String(u), "http://panel.test").pathname, JSON.parse(String(init?.body))]);

describe("Reports", () => {
  it("says the module is off and how to turn it on", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/reports" ? { status: 503, body: { error: "report module is not available" } } : undefined));
    renderRoute("/reports");
    expect(await screen.findByRole("heading", { name: "回報模組沒有啟動" })).toBeInTheDocument();
  });

  it("lists the drafts apart from the decided ones, with the likely duplicate and the GitHub state", async () => {
    mockFetch((_m, url) =>
      url.pathname === "/api/reports"
        ? {
            body: list([
              draft("r1", { likely_duplicate: { number: 12, title: "[voice] 聽不到", url: "https://github.test/o/r/issues/12" }, last_error: "GitHub answered 403" }),
              draft("r2", { status: "opened", title: "卡片沒有出現", issue: { number: 41, url: "https://github.test/o/r/issues/41" }, closed_at: iso(60_000), close_reason: "completed", notified_at: iso(60_000) }),
              draft("r3", { status: "rejected", title: "不是問題", reason: "是功能", person_id: null, place: null }),
            ]),
          }
        : undefined,
    );
    renderRoute("/reports");
    const pending = await screen.findByText("語音頻道裡她聽不到人說話");
    const row = pending.closest("li") as HTMLElement;
    expect(within(row).getByRole("link", { name: "#12" })).toHaveAttribute("href", "https://github.test/o/r/issues/12");
    expect(within(row).getByRole("alert")).toHaveTextContent("GitHub answered 403");
    expect(screen.getByText("owner/repo")).toBeInTheDocument();
    const opened = screen.getByText("卡片沒有出現").closest("li") as HTMLElement;
    expect(within(opened).getByText("已開 issue")).toBeInTheDocument();
    expect(within(opened).getByRole("link", { name: "#41" })).toBeInTheDocument();
    expect(within(opened).getByText(/做完關掉了/)).toBeInTheDocument();
    expect(within(opened).getByText("已提醒她跟回報的人說")).toBeInTheDocument();
    const rejected = screen.getByText("不是問題").closest("li") as HTMLElement;
    expect(within(rejected).getByText("是功能")).toBeInTheDocument();
    expect(within(rejected).getByText("回報的人不知道是誰或已被遺忘")).toBeInTheDocument();
  });

  it("approves with an edited title and sends only what changed", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((method, url) => {
      if (method === "GET" && url.pathname === "/api/reports") return { body: list([draft("r1")]) };
      if (method === "POST" && url.pathname === "/api/reports/r1/approve") {
        return { body: draft("r1", { status: "opened", issue: { number: 41, url: null } }) };
      }
      return undefined;
    });
    renderRoute("/reports");
    await user.click(await screen.findByRole("button", { name: "核准" }));
    const dialog = await screen.findByRole("dialog");
    const title = within(dialog).getByLabelText("標題");
    expect(title).toHaveValue("[voice] 語音頻道裡她聽不到人說話");
    await user.clear(title);
    await user.type(title, "收音壞了");
    await user.click(within(dialog).getByRole("button", { name: "開 issue" }));
    await waitFor(() => expect(posts(fetch)).toEqual([["/api/reports/r1/approve", { title: "收音壞了" }]]));
  });

  it("cannot approve without a token or repo", async () => {
    mockFetch((_m, url) => (url.pathname === "/api/reports" ? { body: list([draft("r1")], { ready: false, repo: "" }) } : undefined));
    renderRoute("/reports");
    expect(await screen.findByRole("button", { name: "核准" })).toBeDisabled();
    expect(screen.getByText(/沒有設定 token 或 repo/)).toBeInTheDocument();
  });

  it("rejects with a reason", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((method, url) => {
      if (method === "GET" && url.pathname === "/api/reports") return { body: list([draft("r1")]) };
      if (method === "POST" && url.pathname === "/api/reports/r1/reject") return { body: draft("r1", { status: "rejected", reason: "是功能" }) };
      return undefined;
    });
    renderRoute("/reports");
    await user.click(await screen.findByRole("button", { name: /的其他處理/ }));
    await user.click(await screen.findByRole("menuitem", { name: "拒絕" }));
    const dialog = await screen.findByRole("dialog");
    const submit = within(dialog).getByRole("button", { name: "拒絕" });
    expect(submit).toBeDisabled();
    await user.type(within(dialog).getByLabelText(/原因/), "是功能");
    await user.click(submit);
    await waitFor(() => expect(posts(fetch)).toEqual([["/api/reports/r1/reject", { reason: "是功能" }]]));
  });

  it("adds a report to the likely duplicate as a comment", async () => {
    const user = userEvent.setup();
    const fetch = mockFetch((method, url) => {
      if (method === "GET" && url.pathname === "/api/reports") {
        return { body: list([draft("r1", { likely_duplicate: { number: 12, title: "聽不到", url: "" } })]) };
      }
      if (method === "POST" && url.pathname === "/api/reports/r1/comment") return { body: draft("r1", { status: "commented" }) };
      return undefined;
    });
    renderRoute("/reports");
    await user.click(await screen.findByRole("button", { name: /的其他處理/ }));
    await user.click(await screen.findByRole("menuitem", { name: "改成加到 #12 的留言" }));
    const dialog = await screen.findByRole("dialog");
    expect(within(dialog).getByLabelText("Issue 編號")).toHaveValue("12");
    await user.click(within(dialog).getByRole("button", { name: "留言" }));
    await waitFor(() => expect(posts(fetch)).toEqual([["/api/reports/r1/comment", { issue: 12 }]]));
  });
});

describe("parseIssue", () => {
  it("reads 12 and #12, and nothing else", () => {
    expect(parseIssue("12")).toBe(12);
    expect(parseIssue(" #7 ")).toBe(7);
    expect(parseIssue("＃7")).toBe(7);
    expect(parseIssue("0")).toBeNull();
    expect(parseIssue("12a")).toBeNull();
    expect(parseIssue("")).toBeNull();
  });
});
