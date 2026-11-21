// `[modules.report]`: problem reports members make through her, turned into GitHub issues on one
// repository. The module is opt-in (Core's `OPT_IN_MODULES`): it runs only with `enabled = true`.
//
// The token is a secret: it comes from the environment through `${VAR}` in `miyoria.toml`, never
// as plain text in the file. It needs nothing but issues on the one repository: a fine-grained
// personal access token limited to that repository with "Issues: Read and write" (GitHub adds
// "Metadata: Read" on its own). Making that token is the owner's job. A GitHub App installed on
// that repository only, with the same permission, is the other way GitHub offers, but its
// installation tokens expire within the hour and minting them from the App's key is not built: a
// static token is all this reads.

import { setting, settingGroups } from "@miyoria/runtime/kernel";
import { z } from "zod";

/** `owner/name`, as GitHub spells a repository. */
export const REPO = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;

/**
 * ```toml
 * [modules.report]
 * enabled = true
 * token = "${MIYORIA_GITHUB_ISSUES_TOKEN:-}"
 * repo = "owner/name"
 * labels = ["from-discord"]
 * ```
 */
export const ReportConfigSchema = z
  .object({
    /** The issues token; empty: she is not offered the tool and nothing is opened. */
    token: z
      .string()
      .default("")
      .meta(
        setting({
          kind: "text",
          label: "GitHub token",
          help: "只要那一個 repo 的 Issues 讀寫權限;放在環境變數裡,設定檔只引用變數名稱",
          group: "github",
          secret: true,
        }),
      ),
    /** Where issues are opened, `owner/name`; empty: nothing is opened. */
    repo: z
      .string()
      .regex(/^([A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100})?$/, "owner/name")
      .default("")
      .meta(setting({ kind: "text", label: "Repo", help: "owner/name", group: "github" })),
    /** Labels every issue opened from a report gets (they must exist on the repository). */
    labels: z.array(z.string().min(1).max(50)).max(10).default([]),
    /** Reports one person may make in 24 hours. */
    per_person_daily: z
      .number()
      .int()
      .nonnegative()
      .default(3)
      .meta(setting({ kind: "number", label: "每人每天", group: "limits" })),
    /** Reports everyone together may make in 24 hours. */
    global_daily: z
      .number()
      .int()
      .nonnegative()
      .default(20)
      .meta(setting({ kind: "number", label: "全部每天", group: "limits" })),
    /**
     * A report that passes every guard (the caps, no likely duplicate) opens an issue without
     * waiting for the owner. Off: every report waits as a draft in the panel.
     */
    auto_open: z
      .boolean()
      .default(false)
      .meta(
        setting({
          kind: "switch",
          label: "不經審核直接開",
          danger: "成員說的內容會直接出現在公開的 issue 上",
          group: "github",
        }),
      ),
    /** How often the issues opened from reports are checked for being closed. */
    poll_mins: z.number().int().min(5).default(30),
    /** The REST API's root (GitHub Enterprise has its own). */
    api_url: z.url().default("https://api.github.com"),
  })
  .meta(
    settingGroups([
      { id: "github", label: "GitHub" },
      { id: "limits", label: "次數" },
    ]),
  );
export type ReportConfig = z.output<typeof ReportConfigSchema>;

export function reportConfig(value: unknown = {}): ReportConfig {
  return ReportConfigSchema.parse(value);
}
