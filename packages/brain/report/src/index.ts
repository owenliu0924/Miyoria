// @miyoria/brain/report: problems members report through her, turned into GitHub issues.
//
// * `report_problem` (`tool.ts`): she writes a report down as a draft; what the member said is
//   data, cleaned by code (`sanitize.ts`) before anything is kept.
// * `ReportService` (`ReportKey`): caps per person and in all, a duplicate search over the
//   repository's open issues, the owner's decisions (approve, comment on #N, duplicate of #N,
//   reject) and the closure poll, with a follow-up for her when a reported problem was fixed.
// * `GitHubIssues`: the four REST calls, over an injected `fetch`.
// * Module `report` (opt-in): `[modules.report]`, the tool and the poll.
// * Storage: the plugin owns `report_drafts` (`schema.ts`, `migrations.ts`); Core opens the store
//   with `reportTables`.

export { REPO, type ReportConfig, ReportConfigSchema, reportConfig } from "./config.js";
export {
  type IssueMatch,
  LIKELY_DUPLICATE,
  likelyDuplicate,
  searchTerms,
  titleSimilarity,
} from "./duplicates.js";
export {
  type FetchLike,
  GitHubError,
  GitHubIssues,
  type GitHubOptions,
  type IssueState,
  type IssueTracker,
  type OpenedIssue,
} from "./github.js";
export { reportSchema } from "./migrations.js";
export { ReportKey, ReportModule, type ReportModuleOptions } from "./module.js";
export { fixedText, memoryNotifier } from "./notify.js";
export {
  LIMITS,
  markdownText,
  normalizeTitle,
  type PlainOptions,
  plainText,
  REMOVED,
} from "./sanitize.js";
export { REPORT_STATUSES, type ReportStatus, reportDrafts } from "./schema.js";
export {
  AREA_NAMES,
  areaOf,
  CAP_WINDOW_MS,
  commentBody,
  type Decided,
  type FixedNotice,
  issueBody,
  issueTitle,
  POLL_BATCH,
  REPORT_AREAS,
  type Refusal,
  type ReportArea,
  type Reporter,
  type ReportFields,
  type ReportInput,
  type ReportNotifier,
  type ReportOutcome,
  ReportService,
  type ReportServiceDeps,
} from "./service.js";
export { FOLLOWED, type ReportRow, ReportTables, reportTables } from "./store.js";
export { outcomeText, REPORT_PROBLEM, REPORT_TOOL, reportTool } from "./tool.js";
