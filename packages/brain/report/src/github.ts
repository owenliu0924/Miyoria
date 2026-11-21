// The four calls of GitHub's REST API a report needs, with plain `fetch` (no client package for
// four requests): search the repository's open issues by title, open an issue, comment on one, and
// read one back to see whether it was closed. `fetch` is injected, so tests never reach GitHub.
//
// The token goes in the `Authorization` header and nowhere else: not in a URL, an error, a log
// line or `toJSON`.

import type { IssueMatch } from "./duplicates.js";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/** Longest wait for one call. */
const TIMEOUT_MS = 15_000;
const API_VERSION = "2022-11-28";

/** A call GitHub refused or that did not arrive; `status` 0 when there was no answer. */
export class GitHubError extends Error {
  override readonly name = "GitHubError";

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface OpenedIssue {
  number: number;
  url: string;
}

export interface IssueState {
  number: number;
  state: "open" | "closed";
  /** `completed`, `not_planned`, `reopened`, `duplicate`; `null` when GitHub says none. */
  reason: string | null;
  closed_at: string | null;
  url: string;
}

/** What a report does on GitHub. */
export interface IssueTracker {
  /** Open issues of the repository whose title has every one of `terms`. */
  search(terms: readonly string[], limit?: number): Promise<IssueMatch[]>;
  open(issue: { title: string; body: string; labels: readonly string[] }): Promise<OpenedIssue>;
  comment(number: number, body: string): Promise<{ url: string }>;
  issue(number: number): Promise<IssueState>;
}

export interface GitHubOptions {
  token: string;
  /** `owner/name`. */
  repo: string;
  apiUrl?: string;
  fetch?: FetchLike;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** GitHub's REST API for one repository. */
export class GitHubIssues implements IssueTracker {
  readonly #token: string;
  readonly #repo: string;
  readonly #api: string;
  readonly #fetch: FetchLike;

  constructor(options: GitHubOptions) {
    this.#token = options.token;
    this.#repo = options.repo;
    this.#api = (options.apiUrl ?? "https://api.github.com").replace(/\/+$/, "");
    this.#fetch = options.fetch ?? ((input, init) => fetch(input, init));
  }

  get repo(): string {
    return this.#repo;
  }

  /** Never the token. */
  toJSON(): { repo: string; api: string } {
    return { repo: this.#repo, api: this.#api };
  }

  async #call(method: "GET" | "POST", path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${this.#api}${path}`, {
        method,
        headers: {
          Accept: "application/vnd.github+json",
          Authorization: `Bearer ${this.#token}`,
          "X-GitHub-Api-Version": API_VERSION,
          "User-Agent": "miyoria-report",
          ...(body === undefined ? {} : { "Content-Type": "application/json" }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        redirect: "error",
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
    } catch (error) {
      const why = error instanceof Error && error.name === "TimeoutError" ? "timed out" : "failed";
      throw new GitHubError(0, `GitHub ${method} ${path.split("?")[0]}: the request ${why}`);
    }
    const text = await response.text().catch(() => "");
    let parsed: unknown = null;
    try {
      parsed = text === "" ? null : JSON.parse(text);
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      const said = isObject(parsed) && typeof parsed.message === "string" ? parsed.message : "";
      throw new GitHubError(
        response.status,
        `GitHub answered ${response.status}${said === "" ? "" : `: ${said.slice(0, 200)}`}`,
      );
    }
    return parsed;
  }

  #issues(rest = ""): string {
    return `/repos/${this.#repo}/issues${rest}`;
  }

  async search(terms: readonly string[], limit = 5): Promise<IssueMatch[]> {
    const words = terms.map((t) => (/\s/.test(t) ? `"${t.replace(/"/g, "")}"` : t));
    const q = [`repo:${this.#repo}`, "is:issue", "is:open", "in:title", ...words].join(" ");
    const found = await this.#call(
      "GET",
      `/search/issues?q=${encodeURIComponent(q)}&per_page=${Math.min(Math.max(limit, 1), 20)}`,
    );
    const items = isObject(found) && Array.isArray(found.items) ? found.items : [];
    return items.flatMap((item): IssueMatch[] =>
      isObject(item) &&
      typeof item.number === "number" &&
      typeof item.title === "string" &&
      typeof item.html_url === "string" &&
      // The search finds pull requests too unless told; never offer one.
      item.pull_request === undefined
        ? [{ number: item.number, title: item.title, url: item.html_url }]
        : [],
    );
  }

  async open(issue: {
    title: string;
    body: string;
    labels: readonly string[];
  }): Promise<OpenedIssue> {
    const made = await this.#call("POST", this.#issues(), {
      title: issue.title,
      body: issue.body,
      ...(issue.labels.length === 0 ? {} : { labels: [...issue.labels] }),
    });
    if (!isObject(made) || typeof made.number !== "number" || typeof made.html_url !== "string") {
      throw new GitHubError(0, "GitHub opened an issue but its answer has no number");
    }
    return { number: made.number, url: made.html_url };
  }

  async comment(number: number, body: string): Promise<{ url: string }> {
    const made = await this.#call("POST", this.#issues(`/${number}/comments`), { body });
    if (!isObject(made) || typeof made.html_url !== "string") {
      throw new GitHubError(0, "GitHub added the comment but its answer has no link");
    }
    return { url: made.html_url };
  }

  async issue(number: number): Promise<IssueState> {
    const got = await this.#call("GET", this.#issues(`/${number}`));
    if (!isObject(got) || typeof got.number !== "number" || typeof got.state !== "string") {
      throw new GitHubError(0, `GitHub's answer for #${number} is not an issue`);
    }
    return {
      number: got.number,
      state: got.state === "closed" ? "closed" : "open",
      reason: typeof got.state_reason === "string" ? got.state_reason : null,
      closed_at: typeof got.closed_at === "string" ? got.closed_at : null,
      url: typeof got.html_url === "string" ? got.html_url : "",
    };
  }
}
