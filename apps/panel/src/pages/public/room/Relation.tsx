import { CornerDownRight, Eraser, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { RoomMemory, RoomRelation } from "@miyoria/contracts/api";
import { Ring, tierWords } from "./BondMark";
import { FINE_RELATION, memoryDate, memoryKind, problemOf } from "./room-text";

function Memory({
  memory,
  onAsk,
  onForget,
}: {
  memory: RoomMemory;
  onAsk: (memory: RoomMemory) => void;
  onForget: (id: string) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [asking, setAsking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [gone, setGone] = useState<"forgot" | "missing" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const yes = useRef<HTMLButtonElement>(null);
  const forget = useRef<HTMLButtonElement>(null);
  const asked = useRef(false);
  const moreId = `hr-mem-${memory.id}`;
  useEffect(() => {
    if (asking) {
      asked.current = true;
      yes.current?.focus();
    } else if (asked.current) {
      forget.current?.focus();
    }
  }, [asking]);

  if (gone) return <li className="hr-forgot">{gone === "forgot" ? "她忘掉了一件事" : "這件事已經不在了"}</li>;
  const kind = memoryKind(memory.kind);
  return (
    <li>
      <button type="button" className="hr-mem" aria-expanded={open} aria-controls={moreId} onClick={() => setOpen((o) => !o)}>
        <span className="hr-d">{memoryDate(memory.date)}</span>
        <span className="hr-t">{memory.text}</span>
      </button>
      {open && (
        <div className="hr-mem-more" id={moreId}>
          {kind}
          {asking ? (
            <div className="hr-confirm">
              <p>她會忘掉這件事,不能復原。你們的羈絆不會因此改變。</p>
              <div className="hr-actions">
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
                      setGone((await onForget(memory.id)) ? "forgot" : "missing");
                    } catch (e) {
                      setError(problemOf(e));
                      setBusy(false);
                    }
                  }}
                >
                  忘掉
                </button>
                <button type="button" className="hr-btn" data-ghost="" onClick={() => setAsking(false)}>
                  算了
                </button>
              </div>
              {error && (
                <p className="hr-alert" role="alert">
                  {error}
                </p>
              )}
            </div>
          ) : (
            <div className="hr-actions">
              <button type="button" className="hr-btn" onClick={() => onAsk(memory)}>
                <CornerDownRight aria-hidden="true" />
                問她這件事
              </button>
              <button ref={forget} type="button" className="hr-btn" data-ghost="" onClick={() => setAsking(true)}>
                <Eraser aria-hidden="true" />
                請她忘掉
              </button>
            </div>
          )}
        </div>
      )}
    </li>
  );
}

/**
 * Her words about them, opened from the ring: the tier, the line she wrote for them and what she
 * remembers, each with 問她這件事 and 請她忘掉. Where a memory was said is not shown (§1).
 */
export function Relation({
  relation,
  failed,
  onClose,
  onAsk,
  onForget,
}: {
  relation: RoomRelation | undefined;
  failed: boolean;
  onClose: () => void;
  onAsk: (memory: RoomMemory) => void;
  onForget: (id: string) => Promise<boolean>;
}) {
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    close.current?.focus({ preventScroll: true });
  }, []);
  const bond = relation?.bond ?? null;
  const title = "hr-relation-title";
  return (
    <section
      className="hr-panel"
      role="dialog"
      aria-labelledby={title}
      onKeyDown={(e) => {
        if (e.key !== "Escape") return;
        e.stopPropagation();
        onClose();
      }}
    >
      <div className="hr-panel-head">
        <Ring bond={bond} />
        <span className="hr-tier">
          <b id={title}>{relation ? tierWords(bond) : "你們"}</b>
          {bond?.next_label && <span>離「{bond.next_label}」還有一段</span>}
        </span>
        <span className="hr-grow" />
        <button ref={close} type="button" className="hr-ib" aria-label="關閉" onClick={onClose}>
          <X className="hr-i" aria-hidden="true" />
        </button>
      </div>
      {!relation ? (
        <p className="hr-empty" role={failed ? "alert" : undefined}>
          {failed ? "讀不到她寫給你的" : "讀取中"}
        </p>
      ) : (
        <>
          {relation.feeling && (
            <>
              <h3>她寫給你的</h3>
              <p className="hr-said">
                <q>{relation.feeling}</q>
              </p>
            </>
          )}
          <h3>她記得的</h3>
          {relation.memories.length === 0 ? (
            <p className="hr-empty">她還沒有記得的事</p>
          ) : (
            <ul className="hr-mems">
              {relation.memories.map((m) => (
                <Memory key={m.id} memory={m} onAsk={onAsk} onForget={onForget} />
              ))}
            </ul>
          )}
          <p className="hr-fine">{FINE_RELATION}</p>
        </>
      )}
    </section>
  );
}
