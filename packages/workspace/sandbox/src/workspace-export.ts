// `workspace.export`: one file of her workspace becomes an artifact (v5-architecture §11.2), the
// first step to handing it to someone (`share`).
//
// Only a path inside her workspace is taken (the same checks as `workspace.read`: no `..`, no
// links), and what comes out is a copy in the artifact store, made in this turn, for the person
// who asked, where the turn happens: a file made in a DM is seen in that DM only, one made in a
// channel in that channel only (the store never makes it wider). Whatever a program wrote there is
// untrusted: the store decides the type from the bytes and takes text, images, audio, video, PDF,
// archives (zip, tar, tar.gz, a single .gz) and the zip-based documents (docx, xlsx, pptx,
// OpenDocument, epub: the file's extension only says which); HTML, scripts and the rest of text
// come in as `text/plain` under their own extension. An archive whose listing climbs out of its
// folder, holds a link or unpacks to too much is refused here already, and so is a 7z or rar,
// which cannot be looked into (`checkContent`, the check `share` makes again). A member's export
// comes from their own folder only (`people.ts`).

import {
  type ActionResult,
  ActuatorRegistryKey,
  type Capability,
  checkContent,
  defineCapability,
  ShareConfigSchema,
  ZIP_MIMES,
  zipLimits,
} from "@miyoria/gate/actions";
import {
  ArtifactInputError,
  type ArtifactStore,
  ArtifactStoreKey,
  ArtifactTooLargeError,
  ArtifactTypeError,
  SNIFF_BYTES,
  sniff,
} from "@miyoria/store";
import { escapeData } from "@miyoria/types";
import {
  WORKSPACE_EXPORT,
  type WorkspaceExportArgs,
  WorkspaceExportArgsSchema,
} from "./capabilities.js";
import { NODE_WORKSPACE } from "./nodes.js";
import { type PersonLimits, workspaceFor } from "./people.js";
import { SandboxError } from "./types.js";
import type { WorkspaceApi } from "./workspace-store.js";

/** The default of `[modules.sandbox.workspace] export_max_kb`, in bytes. */
const MAX_EXPORT_BYTES = 256 * 1024 * 1024;

/** The zip-based document types, by extension: a zip with one of these names is stored as that type. */
const OFFICE: Readonly<Record<string, string>> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  odt: "application/vnd.oasis.opendocument.text",
  ods: "application/vnd.oasis.opendocument.spreadsheet",
  odp: "application/vnd.oasis.opendocument.presentation",
  epub: "application/epub+zip",
};

/** Whether the first bytes are not text: where a format the store cannot take may be hiding. */
function binaryHead(head: Uint8Array): boolean {
  return head.some((b) => b >= 0x80 || (b < 0x20 && b !== 0x09 && b !== 0x0a && b !== 0x0d));
}

function officeType(path: string): string | null {
  const ext = baseName(path).split(".").at(-1)?.toLowerCase() ?? "";
  return OFFICE[ext] ?? null;
}

function sized(bytes: number): string {
  return `${(bytes / 1024 / 1024).toFixed(bytes < 1024 * 1024 ? 2 : 1)} MB`;
}

function refused(text: string, code: string, path: string): ActionResult {
  return { text, data: { ok: false, refused: code, path } };
}

function baseName(path: string): string {
  return path.split("/").at(-1) ?? path;
}

export interface WorkspaceExportOptions {
  workspace: WorkspaceApi;
  /** The caps of one person's folder (default `DEFAULT_PERSON_LIMITS`). */
  people?: PersonLimits;
  /** The largest file taken out, in bytes (default 256 MiB). */
  maxBytes?: number;
}

/** `workspace.export`, over her workspace and the app's artifact store. */
export function workspaceExportCapability(
  options: WorkspaceExportOptions,
): Capability<WorkspaceExportArgs> {
  const maxBytes = options.maxBytes ?? MAX_EXPORT_BYTES;
  return defineCapability<WorkspaceExportArgs>({
    name: WORKSPACE_EXPORT,
    summary: "把她工作區的一個檔案存成產物(之後才能用 share 傳給人)",
    risk: "low",
    args: WorkspaceExportArgsSchema,
    permission: NODE_WORKSPACE,
    tool: {
      name: "workspace_export",
      meta: { effect: "act", speed: "instant", group: "files", core: true },
      description:
        "把工作區裡的一個檔案存成產物,回給你它的 id;要把檔案交給人,就用這個 id 呼叫 share。" +
        "產物是給現在開口要的人做的,只在現在這個頻道或私訊裡看得到。" +
        "收圖片、音訊、影片、PDF、文字檔(markdown、CSV、JSON、程式碼、網頁原始檔)、壓縮檔(zip、tar、tar.gz、gz;7z 和 rar 不收,改用 zip)," +
        "以及 docx / xlsx / pptx / odt / ods / odp / epub;" +
        `一個檔案最多 ${sized(maxBytes)}。替別人做事時只能匯出那個人自己資料夾裡的檔案。`,
      properties: { path: { type: "string", description: "工作區裡的檔案路徑,例如 report.txt" } },
      required: ["path"],
    },
    async execute(args, ctx): Promise<ActionResult> {
      const store: ArtifactStore | undefined = ctx.services.get(ArtifactStoreKey);
      if (!store) return refused("現在沒有產物庫,沒辦法匯出檔案。", "unavailable", args.path);
      const { context, requester } = ctx.principal;
      const site = context === null ? null : store.places.at(context, requester, { create: true });
      if (context !== null && site === null) {
        return refused("我認不出這個地方或這個人,所以不匯出。", "unknown_place", args.path);
      }
      const ws = workspaceFor(options.workspace, ctx.principal, ctx.services, options.people);
      let bytes: Uint8Array;
      try {
        bytes = await ws.workspace.readBytes(args.path, maxBytes);
      } catch (error) {
        if (!(error instanceof SandboxError)) throw error;
        return refused(
          error.kind === "limit"
            ? `沒辦法匯出 ${escapeData(args.path)}:檔案超過 ${sized(maxBytes)}。`
            : `沒辦法匯出 ${escapeData(args.path)}:${escapeData(error.message)}`,
          error.kind,
          args.path,
        );
      }
      const office = officeType(args.path);
      const head = bytes.subarray(0, SNIFF_BYTES);
      const known = sniff(head);
      const archive = known !== null && ZIP_MIMES.includes(known.mime);
      if (archive || (known === null && binaryHead(head.subarray(0, 64)))) {
        // The limits `share` will apply; told now, before a copy is made.
        const share = ctx.services.get(ActuatorRegistryKey)?.config.share;
        const verdict = await checkContent(bytes, true, {
          ...(office === null ? {} : { mime: office }),
          zip: zipLimits(share ?? ShareConfigSchema.parse({})),
          attachment: true,
        });
        if (!verdict.ok && verdict.code === "type_not_allowed") {
          if (verdict.say !== undefined) {
            return refused(`這個檔案不能匯出:${verdict.say}。`, "archive_unreadable", args.path);
          }
          if (archive) {
            return refused(
              `這個壓縮檔不能匯出(${escapeData(verdict.what)}):裡面的檔名不能跑出資料夾、不能有連結,解開也不能大得離譜。`,
              "zip_refused",
              args.path,
            );
          }
        }
      }
      try {
        const artifact = await store.ingest(bytes, {
          source: "sandbox",
          plugin: "sandbox",
          filename: baseName(args.path),
          ...(office === null ? {} : { mime: office }),
          place: site?.place ?? null,
          made_for: site?.person_id ?? null,
          turn: ctx.request.turn,
          signal: ctx.signal,
        });
        return {
          text:
            `已經存成產物 ${artifact.id}(${escapeData(artifact.filename)},${artifact.mime},` +
            `${artifact.size} bytes)。要給人就用 share,artifact 填這個 id。`,
          data: {
            ok: true,
            artifact_id: artifact.id,
            filename: artifact.filename,
            mime: artifact.mime,
            size: artifact.size,
            scope: artifact.scope,
          },
        };
      } catch (error) {
        if (error instanceof ArtifactTypeError) {
          return refused(
            "這個檔案的內容不是能存的類型(收圖片、音訊、影片、PDF、文字檔、壓縮檔和 Office / OpenDocument / epub 文件;docx / xlsx / pptx 這些要真的是那種檔案)。",
            "type_not_allowed",
            args.path,
          );
        }
        if (error instanceof ArtifactTooLargeError) {
          return refused("這個檔案太大了,存不進產物庫。", "too_large", args.path);
        }
        if (error instanceof ArtifactInputError) {
          return refused("在這個地方存不了產物。", "place", args.path);
        }
        throw error;
      }
    },
  }) as Capability<WorkspaceExportArgs>;
}
