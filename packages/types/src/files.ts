import type { MessageRef } from "./platform.js";
import { serviceKey } from "./service-key.js";

// Files people send her (not images). The reader downloads and extracts them in the code sandbox
// and answers with text that is already an untrusted data block; see docs/design/file-attachments.md.

/** A file to read. `who` is a stable key of the sender (`platform:id`), for per-person limits. */
export interface FileRequest {
  who: string;
  name: string;
  url: string;
  /** Size in bytes, when the platform reports it. */
  size: number | null;
  /** Platform id of the attachment (stable, unlike signed URLs): the cache key. */
  id: string | null;
}

/** Why a file was not read. Fixed codes, so nothing inside a file can reach the explanation. */
export type FileDeclineCode =
  | "unsupported"
  | "too_big"
  | "sandbox"
  | "rate"
  | "download"
  | "unreadable";

export type FileOutcome =
  /** `text`: an intro and a data block, safe to put in the prompt as it is. */
  | { status: "read"; text: string; chars: number; truncated: boolean }
  /** `reason`: a short neutral sentence for her. */
  | { status: "declined"; code: FileDeclineCode; reason: string };

/** Reads a user-sent file without ever opening it in the Core process. */
export interface FileReader {
  /** Whether `name` is a type this reader handles (by extension). */
  supports(name: string): boolean;
  read(request: FileRequest, signal: AbortSignal): Promise<FileOutcome>;
}

export const FileReaderKey = serviceKey<FileReader>("FileReader");

/** The files people sent with their messages, as selfhost saw them (`workspace_attach` reads it). */
export interface MessageFiles {
  /**
   * The files of `message` and of the messages the same person sent in the same place within
   * `withinMs` (default 10 minutes) before it, the newest first. Only messages selfhost has seen.
   */
  filesOf(message: MessageRef, options?: { withinMs?: number }): FileRequest[];
}

export const MessageFilesKey = serviceKey<MessageFiles>("MessageFiles");
