import { Download, Eraser, X } from "lucide-react";
import { type KeyboardEvent, type PointerEvent, useEffect, useLayoutEffect, useRef, useState } from "react";
import { SITE_NAME } from "@/lib/site-name";
import type { RoomEntry } from "@miyoria/contracts/api";
import { SwipeTracker } from "./gestures";
import { FINE_BACKLOG, problemOf, when } from "./room-text";

/** Keeps Tab inside `root` (the backlog is modal over the stage). */
export function trapTab(e: KeyboardEvent<HTMLElement>, root: HTMLElement | null): void {
  if (e.key !== "Tab" || !root) return;
  const all = [...root.querySelectorAll<HTMLElement>("button, a[href], textarea, input, [tabindex]:not([tabindex='-1'])")].filter(
    (el) => !el.hasAttribute("disabled") && el.getAttribute("aria-hidden") !== "true",
  );
  const first = all[0];
  const last = all[all.length - 1];
  if (!first || !last) return;
  if (e.shiftKey && document.activeElement === first) {
    e.preventDefault();
    last.focus();
  } else if (!e.shiftKey && document.activeElement === last) {
    e.preventDefault();
    first.focus();
  }
}

function ExcludeLine({ id, onExclude }: { id: string; onExclude: (id: string) => Promise<boolean> }) {
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const again = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  useEffect(() => {
    if (asking) {
      asked.current = true;
      yes.current?.focus();
    } else if (asked.current) {
      again.current?.focus();
    }
  }, [asking]);
  if (!asking) {
    return (
      <div className="hr-entry-actions hr-quiet">
        <button ref={again} type="button" className="hr-btn" data-ghost="" onClick={() => setAsking(true)}>
          <Eraser aria-hidden="true" />
          不要記住這句
        </button>
      </div>
    );
  }
  return (
    <div className="hr-entry-actions hr-confirm" role="group" aria-label="不要記住這句">
      <p className="w-full">她會忘掉這句,紀錄裡也會拿掉,不能復原。</p>
      <button
        ref={yes}
        type="button"
        className="hr-btn"
        aria-disabled={busy || undefined}
        onClick={async () => {
          if (busy) return;
          setBusy(true);
          setError(null);
          try {
            const done = await onExclude(id);
            if (!done) setError("這句已經不在了");
          } catch (e) {
            setError(problemOf(e));
            setBusy(false);
          }
        }}
      >
        不要記住
      </button>
      <button type="button" className="hr-btn" data-ghost="" onClick={() => setAsking(false)}>
        算了
      </button>
      {error && (
        <p className="hr-alert w-full" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

function Entry({
  entry,
  reaction,
  onExclude,
  onDownload,
}: {
  entry: RoomEntry;
  reaction: string | undefined;
  onExclude: (id: string) => Promise<boolean>;
  onDownload: (line: string, n: number) => void;
}) {
  if (entry.type === "mark") {
    return (
      <li className="hr-mark" data-sign={entry.sign}>
        <b>{entry.sign === "plus" ? "+" : "−"}</b>
        <span className="hr-sr">{entry.sign === "plus" ? "羈絆往上" : "羈絆往下"}</span>
        {entry.quote !== null && (
          <>
            她:<q>{entry.quote}</q>
          </>
        )}
      </li>
    );
  }
  const her = entry.who === "her";
  return (
    <li className="hr-entry" data-who={entry.who}>
      <span className="hr-who">
        <b>{her ? SITE_NAME : "你"}</b>
        <time dateTime={entry.at}>{when(entry.at)}</time>
      </span>
      <p>
        {entry.text}
        {reaction && <span aria-label={`她回了 ${reaction}`}> {reaction}</span>}
        {entry.files.length > 0 && !her && <span className="hr-files">附加 {entry.files.map((f) => f.name).join("、")}</span>}
      </p>
      {her && entry.files.some((f) => f.download) && (
        <div className="hr-entry-actions">
          {entry.files.map((f, n) =>
            f.download ? (
              <button key={`${f.name}-${n}`} type="button" className="hr-btn" onClick={() => onDownload(entry.id, n)}>
                <Download aria-hidden="true" />
                {f.name}
              </button>
            ) : null,
          )}
        </div>
      )}
      {!her && <ExcludeLine id={entry.id} onExclude={onExclude} />}
    </li>
  );
}

/**
 * The backlog over the stage, she faintly behind it: both sides, times and where her bond moved.
 * Opened by 紀錄, PageUp, wheel up or a swipe up; closed by 關閉, Escape or a swipe down on its head.
 */
export function Backlog({
  entries,
  older,
  loaded,
  reactions,
  onOlder,
  onClose,
  onExclude,
  onDownload,
}: {
  entries: readonly RoomEntry[];
  older: string | null;
  loaded: boolean;
  reactions: Record<string, string>;
  onOlder: () => Promise<void>;
  onClose: () => void;
  onExclude: (id: string) => Promise<boolean>;
  onDownload: (line: string, n: number) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  const swipe = useRef(new SwipeTracker(1));
  const [drag, setDrag] = useState(0);
  const [loadingOlder, setLoadingOlder] = useState(false);
  const anchor = useRef<{ height: number; top: number } | null>(null);
  const first = useRef(true);
  const title = "hr-backlog-title";

  // Opened: focus on 關閉, the newest line in view.
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, []);

  // New lines at the bottom keep the newest in view; an older page keeps what was read in place.
  useLayoutEffect(() => {
    const el = list.current;
    if (!el) return;
    if (anchor.current) {
      el.scrollTop = el.scrollHeight - anchor.current.height + anchor.current.top;
      anchor.current = null;
      return;
    }
    if (first.current || el.scrollHeight - el.scrollTop - el.clientHeight < 120) el.scrollTop = el.scrollHeight;
    first.current = false;
  }, [entries]);

  // A line left out leaves with the button that had focus: focus stays in the dialog (on 關閉), so
  // Escape and Tab still work.
  const exclude = async (id: string) => {
    const done = await onExclude(id);
    if (done) close.current?.focus({ preventScroll: true });
    return done;
  };

  const readOlder = async () => {
    const el = list.current;
    if (older === null || loadingOlder) return;
    if (el) anchor.current = { height: el.scrollHeight, top: el.scrollTop };
    setLoadingOlder(true);
    try {
      await onOlder();
    } finally {
      setLoadingOlder(false);
    }
  };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    if (e.button > 0 || (e.target as Element).closest("button, a")) return;
    // No text selection or native drag (either would cancel the pointer), and the pointer stays
    // the head's when a mouse leaves it.
    e.preventDefault();
    try {
      e.currentTarget.setPointerCapture(e.pointerId);
    } catch {
      // A pointer the page cannot capture.
    }
    swipe.current.down(e.clientX, e.clientY, e.pointerId);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const dy = swipe.current.move(e.clientX, e.clientY, e.pointerId);
    if (dy === null) return;
    setDrag(Math.max(dy, 0));
  };
  const up = (e: PointerEvent<HTMLDivElement>) => {
    const end = swipe.current.up(e.clientX, e.clientY, e.pointerId, e.type === "pointercancel");
    setDrag(0);
    if (end === "swipe") onClose();
  };

  return (
    <section
      ref={root}
      className="hr-backlog"
      role="dialog"
      aria-modal="true"
      aria-labelledby={title}
      data-dragging={drag ? "" : undefined}
      style={drag ? { transform: `translateY(${drag * 0.6}px)` } : undefined}
      onKeyDown={(e) => {
        if (e.key === "Escape") {
          e.stopPropagation();
          onClose();
          return;
        }
        trapTab(e, root.current);
      }}
    >
      <div className="hr-bl-head" onPointerDown={down} onPointerMove={move} onPointerUp={up} onPointerCancel={up}>
        <div className="hr-handle" aria-hidden="true" />
        <h2 id={title}>紀錄</h2>
        <span className="hr-grow" />
        <button ref={close} type="button" className="hr-tb" onClick={onClose}>
          <X className="hr-i" aria-hidden="true" />
          關閉
        </button>
      </div>
      <div
        ref={list}
        className="hr-bl-list"
        onScroll={(e) => {
          if (e.currentTarget.scrollTop < 40) void readOlder();
        }}
      >
        <div className="hr-bl-inner">
          {older !== null && (
            <div className="hr-older">
              <button type="button" className="hr-tb" onClick={() => void readOlder()} aria-disabled={loadingOlder || undefined}>
                {loadingOlder ? "讀取中" : "更早的"}
              </button>
            </div>
          )}
          {loaded && entries.length === 0 ? (
            <p className="hr-empty">還沒有說過話</p>
          ) : (
            <ol className="m-0 list-none p-0" aria-label="你們說的話">
              {entries.map((e) => (
                <Entry
                  key={e.id}
                  entry={e}
                  reaction={reactions[e.id]}
                  onExclude={exclude}
                  onDownload={onDownload}
                />
              ))}
            </ol>
          )}
          <p className="hr-fine">{FINE_BACKLOG}</p>
        </div>
      </div>
    </section>
  );
}
