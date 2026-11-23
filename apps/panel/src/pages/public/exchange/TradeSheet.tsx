// Buy and sell one tap away on a phone: a bar stuck to the bottom of the viewport while a ticker is
// open (the module page's unsaved-changes band: a hairline, a darker fill, a blur of what scrolls
// under it), its two buttons solid in the member's up and down colours, and the ticket in a bottom
// sheet. The sheet is a real dialog (Radix): focus moves into the amount field and stays inside,
// Esc closes it, and focus goes back to the button that opened it. Its slide stops under reduced
// motion with every other animation.

import * as DialogPrimitive from "@radix-ui/react-dialog";
import { XIcon } from "lucide-react";
import { type ReactNode, type RefObject, useRef } from "react";
import type { ExchangeLine } from "@miyoria/contracts/api";
import { type Colors, MARKET_INK } from "./common";
import type { Side } from "./trade-math";
import { sideColor, TradeHeader } from "./TradeForm";

/** The two buttons; a side that cannot be used is a neutral button that says why. */
export function TradeBar({ colors, blocks, onOpen }: { colors: Colors; blocks: Record<Side, string | null>; onOpen: (side: Side) => void }) {
  return (
    <div
      role="region"
      aria-label="買賣"
      data-trade-bar
      className="sticky bottom-3 z-10 mb-[env(safe-area-inset-bottom)] grid grid-cols-2 gap-2 rounded-[10px] border border-line-strong bg-[rgba(8,9,14,0.9)] p-2 backdrop-blur-md [text-shadow:none]"
    >
      {(["buy", "sell"] as const).map((s) => {
        const why = blocks[s];
        return (
          <button
            key={s}
            type="button"
            disabled={why !== null}
            onClick={() => onOpen(s)}
            className="inline-flex h-12 items-center justify-center rounded-md text-[15px] font-semibold outline-none transition-[filter] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring enabled:hover:brightness-110 disabled:bg-control disabled:text-muted-foreground"
            style={why === null ? { background: sideColor(s, colors), color: MARKET_INK } : undefined}
          >
            {s === "buy" ? "買進" : "賣出"}
            {why && <span className="text-xs font-normal">{`・${why}`}</span>}
          </button>
        );
      })}
    </div>
  );
}

/** The bottom sheet around the ticket: its header (the ticker, the live price), then the ticket. */
export function TradeSheet({
  open,
  onOpenChange,
  line,
  colors,
  opener,
  children,
}: {
  open: boolean;
  /** What opened it, to get focus back (else the bar's first button that can be used). */
  opener?: RefObject<HTMLElement | null>;
  onOpenChange: (open: boolean) => void;
  line: ExchangeLine;
  colors: Colors;
  /** The ticket; gets the ref of the field to focus first. */
  children: (focus: RefObject<HTMLInputElement | null>) => ReactNode;
}) {
  const focus = useRef<HTMLInputElement | null>(null);
  return (
    <DialogPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay className="fixed inset-0 z-50 bg-black/55 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:animate-in data-[state=open]:fade-in-0" />
        <DialogPrimitive.Content
          aria-describedby={undefined}
          tabIndex={-1}
          onCloseAutoFocus={(e) => {
            e.preventDefault();
            const back = opener?.current?.isConnected ? opener.current : document.querySelector<HTMLElement>("[data-trade-bar] button:not(:disabled)");
            back?.focus();
          }}
          onOpenAutoFocus={(e) => {
            // The amount field when the ticket is there; else the sheet itself, not its close button.
            e.preventDefault();
            (focus.current ?? (e.currentTarget as HTMLElement | null))?.focus();
          }}
          className="glass-float fixed inset-x-0 bottom-0 z-50 mx-auto flex max-h-[92dvh] w-full max-w-lg flex-col rounded-t-[14px] border-b-0 outline-none data-[state=closed]:animate-out data-[state=closed]:duration-200 data-[state=closed]:slide-out-to-bottom data-[state=open]:animate-in data-[state=open]:duration-300 data-[state=open]:slide-in-from-bottom"
        >
          <div aria-hidden className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-line-strong" />
          <div className="flex shrink-0 items-start justify-between gap-3 px-4 pt-2 pb-3">
            <TradeHeader
              line={line}
              colors={colors}
              title={
                <DialogPrimitive.Title className="flex min-w-0 items-baseline gap-2 text-[15px] font-semibold">
                  <span className="font-mono text-[14px]">{line.code}</span>
                  <span className="truncate">{line.name}</span>
                </DialogPrimitive.Title>
              }
            />
            <DialogPrimitive.Close className="-mt-1 -mr-2 inline-flex size-11 shrink-0 items-center justify-center rounded-md text-muted-foreground outline-none transition-colors hover:bg-hover hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring">
              <XIcon className="size-4" />
              <span className="sr-only">關閉</span>
            </DialogPrimitive.Close>
          </div>
          {children(focus)}
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}
