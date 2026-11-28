import { BondRing } from "@miyoria/card-face";
import { type RefObject, useEffect, useState } from "react";
import type { MemberBond } from "@miyoria/contracts/api";
import type { BondChange } from "./room-store";

/** How long a bond change's reason stays in the corner, ms. */
export const BOND_SHOW_MS = 8_000;

/** The ring for a bond (a stranger's is empty). */
export function Ring({ bond }: { bond: MemberBond | null }) {
  return (
    <span className="hr-ring" aria-hidden="true">
      <BondRing title="" lap={bond?.ring.lap ?? 0} fraction={bond?.ring.fraction ?? 0} full={bond?.ring.full ?? false} />
    </span>
  );
}

export function tierWords(bond: MemberBond | null): string {
  return bond ? (bond.tier_label ?? bond.tier) : "還不認識";
}

/**
 * The bond in the top right corner: the ring, which opens her words about them; under it, while a
 * change is new, its direction and her quoted reason. Never a number.
 */
export function BondMark({
  bond,
  change,
  open,
  onToggle,
  buttonRef,
}: {
  bond: MemberBond | null;
  change: BondChange | null;
  open: boolean;
  onToggle: () => void;
  buttonRef: RefObject<HTMLButtonElement | null>;
}) {
  const [faded, setFaded] = useState<string | null>(null);
  useEffect(() => {
    if (!change) return;
    const timer = setTimeout(() => setFaded(change.id), BOND_SHOW_MS);
    return () => clearTimeout(timer);
  }, [change]);
  const showing = change !== null && faded !== change.id;
  const tier = tierWords(bond);
  return (
    <section className="hr-bond" aria-label="羈絆" data-change={showing ? change.sign : undefined}>
      <button
        ref={buttonRef}
        type="button"
        className="hr-bond-btn"
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-label={`你們:${tier}`}
        title={tier}
        onClick={onToggle}
      >
        <Ring bond={bond} />
      </button>
      <div role="status">
        {change && (
          <p key={change.id} className="hr-delta" data-sign={change.sign} data-faded={showing ? undefined : ""}>
            <b>{change.sign === "plus" ? "+" : "−"}</b>
            <span className="hr-sr">{change.sign === "plus" ? "羈絆往上" : "羈絆往下"}</span>
            {change.quote !== null && (
              <>
                她:<q>{change.quote}</q>
              </>
            )}
          </p>
        )}
      </div>
    </section>
  );
}
