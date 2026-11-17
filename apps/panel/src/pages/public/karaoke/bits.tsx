// Small pieces the karaoke screens share.

import { Headphones, ShieldCheck } from "lucide-react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

/** Label over value, spaced, no cell walls. */
export function Fact({ label, children, className }: { label: string; children: ReactNode; className?: string }) {
  return (
    <div className={cn("grid min-w-0 gap-0.5", className)}>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="min-w-0 truncate text-sm font-medium tabular-nums">{children}</dd>
    </div>
  );
}

/** The Core's sentence (or the browser's) for what did not happen. */
export function Refusal({ children }: { children: ReactNode }) {
  if (!children) return null;
  return (
    <p role="alert" className="text-[13px] text-primary">
      {children}
    </p>
  );
}

/** Wear headphones: the speakers would sing along. */
export function HeadphonesLine() {
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <Headphones aria-hidden className="size-4 shrink-0" />
      請戴耳機:用喇叭的話,伴唱會被麥克風收進去
    </p>
  );
}

/** What leaves the browser. */
export function PrivacyLine() {
  return (
    <p className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <ShieldCheck aria-hidden className="size-4 shrink-0" />
      麥克風的聲音只在這個瀏覽器裡處理,不會送出去;唱完只送出一小段音高紀錄
    </p>
  );
}

/** A thin bar, 0..1, in the secondary line or the primary. */
export function Bar({ value, label, tone = "neutral" }: { value: number; label: string; tone?: "neutral" | "brand" }) {
  const v = Math.max(0, Math.min(1, value));
  return (
    <div
      role="meter"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={1}
      aria-valuenow={Number(v.toFixed(2))}
      className="h-1.5 w-full min-w-12 overflow-hidden rounded-[2px] bg-muted"
    >
      <div
        className={cn("h-full rounded-[2px]", tone === "brand" ? "bg-primary" : "bg-secondary-line")}
        style={{ width: `${v * 100}%` }}
      />
    </div>
  );
}
