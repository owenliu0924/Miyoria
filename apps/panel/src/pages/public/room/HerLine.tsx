import { ChevronDown, Download } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { RoomFile } from "@miyoria/contracts/api";
import { sizeText } from "./room-text";

/** Characters a tick and the tick, ms: her line comes in a little at a time (the mock's pace). */
export const REVEAL_STEP = 2;
export const REVEAL_MS = 55;

/**
 * A line shown a few characters at a time: `count` is how many are shown. A new `key` starts
 * again; `instant` (reduced motion, a line from the backlog) shows it whole at once.
 */
export function useReveal(key: string | null, text: string, instant: boolean) {
  const chars = [...text];
  const total = chars.length;
  const [state, setState] = useState<{ key: string | null; count: number }>({ key, count: instant ? total : 0 });
  const current = state.key === key ? state.count : instant ? total : 0;
  if (state.key !== key) setState({ key, count: current });

  useEffect(() => {
    if (key === null || current >= total) return;
    const timer = setInterval(() => {
      setState((s) => (s.key !== key ? s : { key, count: Math.min(total, s.count + REVEAL_STEP) }));
    }, REVEAL_MS);
    return () => clearInterval(timer);
  }, [key, total, current >= total]);

  const finish = useCallback(() => setState({ key, count: total }), [key, total]);
  return { shown: chars.slice(0, current).join(""), done: current >= total, finish };
}

export type HerContent =
  | { kind: "thinking"; step: string | null }
  | { kind: "line"; id: string; text: string; files: RoomFile[] }
  | { kind: "closed"; text: string }
  | null;

/**
 * Her current line above the capsule: plain text on the dock's scrim, typed in, with a small arrow
 * while more of her reply waits. Screen readers get the whole line once, from `HerAnnouncer`, not
 * every character.
 */
export function HerLine({
  content,
  shown,
  revealing,
  more,
  speaking,
  onAdvance,
  onClick,
  onDownload,
}: {
  content: HerContent;
  shown: string;
  revealing: boolean;
  more: boolean;
  speaking: boolean;
  onAdvance: () => void;
  /** A click on the line (the page tells it apart from its own tap). */
  onClick?: () => void;
  onDownload: (line: string, n: number) => void;
}) {
  const steppable = content?.kind === "line" && (more || revealing);
  const body = (() => {
    if (content === null) return null;
    if (content.kind === "closed") return content.text;
    if (content.kind === "thinking") {
      return (
        <span className="hr-thinking">
          <span className="hr-pulse" aria-hidden="true" />
          {content.step ? `她在${content.step}` : "她在想"}
        </span>
      );
    }
    return (
      <>
        <span aria-hidden="true">{shown}</span>
        {revealing && <span className="hr-caret" aria-hidden="true" />}
        {speaking && (
          <span className="hr-eq hr-speaking" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
        )}
        {more && !revealing && <ChevronDown className="hr-i hr-cue" aria-hidden="true" />}
      </>
    );
  })();
  return (
    <>
      <p
        className="hr-her"
        data-more={steppable ? "" : undefined}
        data-closed={content?.kind === "closed" ? "" : undefined}
        // Only while there is something to step to: a button then, with its key.
        role={more && !revealing ? "button" : undefined}
        tabIndex={more && !revealing ? 0 : undefined}
        title={more && !revealing ? "下一句(Enter)" : undefined}
        aria-label={more && !revealing ? "下一句" : undefined}
        onClick={steppable ? (onClick ?? onAdvance) : undefined}
        onKeyDown={(e) => {
          if (!steppable || (e.key !== "Enter" && e.key !== " ")) return;
          e.preventDefault();
          onAdvance();
        }}
      >
        {body}
      </p>
      {content?.kind === "line" && content.files.length > 0 && !revealing && (
        <div className="hr-her-files">
          {content.files.map((f, n) =>
            f.download ? (
              <button key={`${f.name}-${n}`} type="button" className="hr-btn" onClick={() => onDownload(content.id, n)}>
                <Download aria-hidden="true" />
                {f.name}
                {f.size !== null && <span style={{ color: "var(--faint)" }}>{sizeText(f.size)}</span>}
              </button>
            ) : null,
          )}
        </div>
      )}
    </>
  );
}

/** The polite live region for her line: the whole line once it is on the stage, never piece by piece. */
export function HerAnnouncer({ text }: { text: string }) {
  const [said, setSaid] = useState("");
  const last = useRef("");
  useEffect(() => {
    if (text === last.current) return;
    last.current = text;
    setSaid(text);
  }, [text]);
  return (
    <div className="hr-sr" aria-live="polite" aria-atomic="true">
      {said}
    </div>
  );
}
