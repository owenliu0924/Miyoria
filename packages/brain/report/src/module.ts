// Module `report` (opt-in): problem reports members make through her, and the GitHub issues they
// become. It owns the `report` plugin's table and provides `ReportKey` (`ReportService`) for the
// panel. With a token and a repo it offers her `report_problem` and reads the issues back every
// `poll_mins`; without them it only keeps and shows the drafts there are.

import { ToolRegistryKey } from "@miyoria/llm/tools";
import {
  defineManifest,
  errorMessage,
  interval,
  type Module,
  type ModuleCard,
  type ModuleContext,
} from "@miyoria/runtime/kernel";
import { PeopleStoreKey, StoreKey } from "@miyoria/store";
import { type Clock, serviceKey } from "@miyoria/types";
import { ReportConfigSchema } from "./config.js";
import { type FetchLike, GitHubIssues, type IssueTracker } from "./github.js";
import { memoryNotifier } from "./notify.js";
import { type ReportNotifier, ReportService } from "./service.js";
import { reportTables } from "./store.js";
import { REPORT_PROBLEM, reportTool } from "./tool.js";

export const ReportKey = serviceKey<ReportService>("Reports");

export interface ReportModuleOptions {
  /** For tests: the `fetch` that reaches GitHub. */
  fetch?: FetchLike;
  /** For tests: replaces the GitHub client altogether. */
  tracker?: IssueTracker;
  /** For tests: replaces the memory follow-up. */
  notifier?: ReportNotifier;
  clock?: Clock;
}

export class ReportModule implements Module {
  static readonly ID = "report";
  readonly manifest = defineManifest(ReportModule.ID, "Report", {
    icon: "bug",
    category: "system",
    description:
      "Problem reports members make through her: drafts the owner reviews, and the GitHub issues they become",
    optional: ["memory", "agent"],
    configSchema: ReportConfigSchema,
  });
  readonly #options: ReportModuleOptions;
  #untool: (() => void) | null = null;
  #service: ReportService | null = null;

  constructor(options: ReportModuleOptions = {}) {
    this.#options = options;
  }

  async start(ctx: ModuleContext): Promise<void> {
    const config = ctx.config(ReportConfigSchema);
    const store = ctx.services.get(StoreKey);
    if (store === undefined) {
      ctx.log.warn("no store: no reports");
      return;
    }
    const clock = this.#options.clock ?? ctx.clock;
    const configured = config.token !== "" && config.repo !== "";
    const tracker =
      this.#options.tracker ??
      (configured
        ? new GitHubIssues({
            token: config.token,
            repo: config.repo,
            apiUrl: config.api_url,
            ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          })
        : null);
    const service = new ReportService({
      config,
      store: store.plugin(reportTables),
      tracker,
      now: () => clock.now(),
      reporter: async (account) => {
        const person = await ctx.services.get(PeopleStoreKey)?.personByAccount(account);
        if (!person) return null;
        return {
          person: person.id,
          names: [person.display_name, ...person.accounts.map((a) => a.display_name)],
        };
      },
      notifier: () => this.#options.notifier ?? memoryNotifier(ctx.services),
      log: ctx.log,
    });
    const recovered = service.recover();
    if (recovered > 0) ctx.log.warn({ recovered }, "report: drafts left waiting on GitHub");
    ctx.provide(ReportKey, service);
    this.#service = service;

    if (tracker === null) {
      ctx.log.warn("report: no token or no repo; she is not offered report_problem");
      return;
    }
    const tools = ctx.services.get(ToolRegistryKey);
    if (tools) {
      tools.register(reportTool(() => this.#service));
      this.#untool = () => tools.unregister(REPORT_PROBLEM);
    }
    const every = config.poll_mins * 60_000;
    ctx.spawn("poll", async (signal) => {
      for await (const _ of interval(every, signal)) {
        try {
          await service.poll(signal);
        } catch (error) {
          ctx.log.warn({ err: errorMessage(error) }, "report: the poll failed");
        }
      }
    });
    ctx.log.info({ repo: config.repo, auto_open: config.auto_open }, "reports running");
  }

  async card(): Promise<ModuleCard> {
    const service = this.#service;
    if (service === null) return { facts: [] };
    const waiting = service.list(["draft"], 1000).length;
    return {
      facts: [
        { label: "待審核", value: String(waiting) },
        { label: "24 小時內", value: String(service.today()) },
        { label: "GitHub", value: service.ready ? service.config.repo : "沒有設定" },
      ],
    };
  }

  async stop(): Promise<void> {
    this.#untool?.();
    this.#untool = null;
    this.#service = null;
  }
}
