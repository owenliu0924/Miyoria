// `workspace.attach`: the files someone sent with their message (or in the last few minutes) are
// saved into their own folder as `inbox/<name>`, where the next `shell_run` sees them at
// `/workspace/inbox/` (docs/design/v6-sandbox.md §11.1).
//
// The download is the file reader's (`files.ts`): HTTPS only, from the platform's own CDN hosts,
// no redirect, a timeout, and measured while it streams, so a file that lies about its size is
// cut off at the cap instead of filling the disk. It goes to a temporary file beside the target
// and is renamed into place (a link a program planted there is replaced, not followed). The caps
// are the person's folder's (`people.ts`) and `max_file_kb`. The file is saved as it came: an
// image's metadata is cleaned when it is shared out (`ArtifactCleanerKey`), not here.
//
// What the platform calls a file is untrusted: its name is cut down to one safe segment, and
// everything printed back to her goes through `escapeData`.

import { randomBytes } from "node:crypto";
import { chmod, lstat, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  type ActionResult,
  type Capability,
  defineCapability,
  type ExecContext,
} from "@miyoria/gate/actions";
import { accountRefString, escapeData, type MessageFiles, MessageFilesKey } from "@miyoria/types";
import { z } from "zod";
import { allowedHost, type FetchLike } from "./files.js";
import { NODE_WORKSPACE } from "./nodes.js";
import { normalizeRelativePath } from "./paths.js";
import { type PersonLimits, scopeFor } from "./people.js";
import { PersistentWorkspace, type WorkspaceApi, type WorkspaceLimits } from "./workspace-store.js";

export const WORKSPACE_ATTACH = "workspace.attach";

/** The folder the files go in, under the person's folder. */
export const INBOX = "inbox";

/** Most files one call saves. */
const MAX_FILES = 10;
const MAX_NAME = 100;

export const WorkspaceAttachArgsSchema = z.object({
  file: z
    .string()
    .min(1)
    .max(200)
    .optional()
    .describe("Only the file with this name (default: all of the recent ones)"),
});
export type WorkspaceAttachArgs = z.output<typeof WorkspaceAttachArgsSchema>;

export interface WorkspaceAttachOptions {
  workspace: WorkspaceApi;
  people: PersonLimits;
  /** `[modules.sandbox.workspace] max_file_kb` x 1024. */
  maxBytes: number;
  /** `[modules.sandbox.files] allowed_hosts`. */
  allowedHosts: readonly string[];
  downloadTimeoutMs: number;
  fetch?: FetchLike;
}

const MIB = 1024 * 1024;

function size(bytes: number): string {
  return bytes < MIB
    ? `${Math.max(1, Math.ceil(bytes / 1024))} KB`
    : `${(bytes / MIB).toFixed(1)} MB`;
}

function shown(text: string): string {
  return escapeData(text).replace(/\s+/g, " ");
}

/** Characters `normalizeRelativePath` refuses in a name, plus the separators. */
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it replaces
const UNSAFE = /[\u0000-\u001f\u007f<>:"|?*\\/]/g;

/**
 * One safe segment from a name the platform reported: no folders, nothing Windows forbids or
 * aliases, at most `MAX_NAME` characters with the extension kept.
 */
export function inboxName(raw: string): string {
  let name = raw.replace(UNSAFE, "_").trim();
  name = name.replace(/[. ]+$/, "");
  if (name === "" || /^\.+$/.test(name)) name = "file";
  if (name.length > MAX_NAME) {
    const dot = name.lastIndexOf(".");
    const ext = dot > 0 && name.length - dot <= 12 ? name.slice(dot) : "";
    name = name.slice(0, MAX_NAME - ext.length) + ext;
  }
  try {
    return normalizeRelativePath(name);
  } catch {
    // A reserved device name and the like: the name is not worth keeping.
    return `file-${name.slice(0, 20).replace(/[^\w.-]/g, "_")}`.replace(/[. ]+$/, "") || "file";
  }
}

/** `name`, or `name-2`, `name-3`, ... before the extension, the first one not in `taken` (lowercase). */
function freeName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name.toLowerCase())) return name;
  const dot = name.lastIndexOf(".");
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const ext = dot > 0 ? name.slice(dot) : "";
  for (let n = 2; ; n += 1) {
    const candidate = `${stem.slice(0, MAX_NAME - ext.length - 6)}-${n}${ext}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

type Fetched = { ok: true; bytes: number } | { ok: false; why: "download" | "too_big" };

/** Streams `url` into `temp`, giving up past `cap` bytes. */
async function download(
  doFetch: FetchLike,
  url: string,
  temp: string,
  cap: number,
  signal: AbortSignal,
): Promise<Fetched> {
  let response: Response;
  try {
    response = await doFetch(url, { signal, redirect: "error" });
  } catch {
    return { ok: false, why: "download" };
  }
  if (!response.ok || response.body === null) {
    await response.body?.cancel().catch(() => undefined);
    return { ok: false, why: "download" };
  }
  const length = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(length) && length > cap) {
    await response.body.cancel().catch(() => undefined);
    return { ok: false, why: "too_big" };
  }
  const handle = await open(temp, "wx", 0o666);
  let total = 0;
  try {
    const reader = response.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.length;
      if (total > cap) {
        await reader.cancel().catch(() => undefined);
        return { ok: false, why: "too_big" };
      }
      await handle.write(value);
    }
  } catch {
    return { ok: false, why: "download" };
  } finally {
    await handle.close();
  }
  return total === 0 ? { ok: false, why: "download" } : { ok: true, bytes: total };
}

const REASONS = {
  host: "不是從平台的檔案網域來的",
  download: "沒能把檔案下載下來",
  too_big: "檔案太大了",
  full: "資料夾放不下了(先刪一些檔案)",
  count: "資料夾的檔案數到上限了",
} as const;

/** The caps of the folder the files go in, and where it is. */
async function target(
  o: WorkspaceAttachOptions,
  ctx: ExecContext,
): Promise<{ ws: PersistentWorkspace; limits: WorkspaceLimits } | null> {
  const root = o.workspace;
  if (!(root instanceof PersistentWorkspace)) return null;
  const scope = scopeFor(ctx.principal, ctx.services);
  if (scope.kind !== "person") return { ws: root, limits: root.limits };
  const limits: WorkspaceLimits = {
    maxBytes: Math.min(o.people.maxBytes, root.limits.maxBytes),
    maxFiles: Math.min(o.people.maxFiles, root.limits.maxFiles),
    maxFileBytes: root.limits.maxFileBytes,
  };
  return { ws: await root.subdir(`people/${scope.folder}`, limits), limits };
}

/** `workspace.attach`, over the folder of whoever asked. */
export function workspaceAttachCapability(
  o: WorkspaceAttachOptions,
): Capability<WorkspaceAttachArgs> {
  const doFetch: FetchLike = o.fetch ?? ((u, init) => fetch(u, init));
  return defineCapability<WorkspaceAttachArgs>({
    name: WORKSPACE_ATTACH,
    summary: "把對方傳來的檔案存進對方的工作資料夾(inbox/)",
    risk: "medium",
    work: true,
    args: WorkspaceAttachArgsSchema,
    permission: NODE_WORKSPACE,
    tool: {
      name: "workspace_attach",
      meta: { effect: "act", speed: "instant", group: "workspace" },
      description:
        "把對方這則訊息附的檔案(或同一個人幾分鐘內傳的)存進對方的工作資料夾 inbox/,原樣存、圖片也行。" +
        "存好之後用 shell_run 在 /workspace/inbox/ 就能處理它們(轉檔、解壓縮、分析)。" +
        "file 只存那個名字的檔案,不填就存最近的全部(最多 10 個)。檔案數、大小和資料夾的額度照工作區的規定。",
      properties: {
        file: { type: "string", description: "只存這個檔名的檔案(可省略)" },
      },
    },
    async execute(a, ctx): Promise<ActionResult> {
      const none = (text: string, code: string): ActionResult => ({
        text,
        data: { ok: false, refused: code },
      });
      const requester = ctx.principal.requester;
      const message = ctx.request.message ?? null;
      const book: MessageFiles | undefined = ctx.services.get(MessageFilesKey);
      if (requester === null || message === null) {
        return none("現在沒有哪個人的訊息在等我處理,沒有可以存的附件。", "no_message");
      }
      if (book === undefined) return none("我現在看不到訊息附的檔案。", "unavailable");
      const who = accountRefString(requester);
      const wanted = a.file?.toLowerCase();
      const files = book
        .filesOf(message)
        .filter((f) => f.who === who && (wanted === undefined || f.name.toLowerCase() === wanted))
        .slice(0, MAX_FILES);
      if (files.length === 0) {
        return none(
          wanted === undefined
            ? "對方最近的訊息沒有附檔案。"
            : `對方最近的訊息裡沒有叫 ${shown(a.file ?? "")} 的檔案。`,
          "no_files",
        );
      }
      const spot = await target(o, ctx);
      if (spot === null) return none("工作區現在不能收檔案。", "unavailable");
      const inbox = await spot.ws.subdir(INBOX, spot.limits);
      const usage = await spot.ws.usage();
      if (usage.overflow) {
        return none("工作區的檔案太多了,先刪一些再存。", "full");
      }
      const taken = new Set((await readdir(inbox.dir)).map((n) => n.toLowerCase()));
      let bytesLeft = spot.limits.maxBytes - usage.bytes;
      let filesLeft = spot.limits.maxFiles - usage.files;
      const saved: { path: string; size: number }[] = [];
      const declined: { name: string; why: keyof typeof REASONS }[] = [];

      for (const f of files) {
        ctx.signal.throwIfAborted();
        const refuse = (why: keyof typeof REASONS) => declined.push({ name: f.name, why });
        if (!allowedHost(f.url, o.allowedHosts)) {
          refuse("host");
          continue;
        }
        if (filesLeft < 1) {
          refuse("count");
          continue;
        }
        const cap = Math.min(o.maxBytes, spot.limits.maxFileBytes, bytesLeft);
        if (f.size !== null && f.size > cap) {
          refuse(f.size > Math.min(o.maxBytes, spot.limits.maxFileBytes) ? "too_big" : "full");
          continue;
        }
        const name = freeName(inboxName(f.name), taken);
        const temp = join(inbox.dir, `.tmp-${randomBytes(6).toString("hex")}`);
        const got = await download(
          doFetch,
          f.url,
          temp,
          cap,
          AbortSignal.any([ctx.signal, AbortSignal.timeout(o.downloadTimeoutMs)]),
        ).catch(async (error: unknown) => {
          await unlink(temp).catch(() => undefined);
          throw error;
        });
        // A stop from outside is not a failed download.
        ctx.signal.throwIfAborted();
        if (!got.ok) {
          await unlink(temp).catch(() => undefined);
          refuse(
            got.why === "too_big" && cap < Math.min(o.maxBytes, spot.limits.maxFileBytes)
              ? "full"
              : got.why,
          );
          continue;
        }
        const final = join(inbox.dir, name);
        try {
          // Not a link or a file already there (the name was free a moment ago).
          if ((await lstat(final).catch(() => null)) !== null) throw new Error("taken");
          await chmod(temp, 0o666);
          await rename(temp, final);
        } catch {
          await unlink(temp).catch(() => undefined);
          refuse("download");
          continue;
        }
        taken.add(name.toLowerCase());
        bytesLeft -= got.bytes;
        filesLeft -= 1;
        saved.push({ path: `${INBOX}/${name}`, size: got.bytes });
      }

      const lines = [
        ...(saved.length === 0
          ? []
          : [
              `已存進工作資料夾(shell_run 在 /workspace/inbox/ 看得到):\n${saved
                .map((s) => `- ${shown(s.path)}(${size(s.size)})`)
                .join("\n")}`,
            ]),
        ...(declined.length === 0
          ? []
          : [`沒存的:\n${declined.map((d) => `- ${shown(d.name)}:${REASONS[d.why]}`).join("\n")}`]),
      ];
      return {
        text: lines.join("\n"),
        data: {
          ok: saved.length > 0,
          saved,
          declined: declined.map((d) => ({ name: d.name.slice(0, 80), why: d.why })),
        },
      };
    },
  }) as Capability<WorkspaceAttachArgs>;
}
