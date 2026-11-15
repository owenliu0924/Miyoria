// What the graphics card reads now, for `host.info` and the report. Only a reading in this step;
// arbitration comes in H7 (docs/design/v5-hostd.md §8).

import { execa } from "execa";

/** One reading of the first card. */
export interface GpuSample {
  name: string;
  total_mb: number;
  used_mb: number;
}

export type GpuReader = () => Promise<GpuSample | null>;

/** `nvidia-smi` CSV without header or units: `name, total, used` per card. The first card. */
export function parseNvidiaSmi(text: string): GpuSample | null {
  for (const line of text.split(/\r?\n/)) {
    const parts = line.split(",").map((p) => p.trim());
    if (parts.length < 3) continue;
    const total = Number(parts[parts.length - 2]);
    const used = Number(parts[parts.length - 1]);
    const name = parts.slice(0, -2).join(",");
    if (!Number.isFinite(total) || !Number.isFinite(used) || name === "") continue;
    return { name, total_mb: total, used_mb: used };
  }
  return null;
}

/** Reads the card with `nvidia-smi`; `null` when the program is missing or fails. */
export const nvidiaSmiReader: GpuReader = async () => {
  const result = await execa(
    "nvidia-smi",
    ["--query-gpu=name,memory.total,memory.used", "--format=csv,noheader,nounits"],
    { reject: false, timeout: 5000, windowsHide: true, stdin: "ignore" },
  );
  if (result.failed || typeof result.stdout !== "string") return null;
  return parseNvidiaSmi(result.stdout);
};

/** Keeps one reading for `ttlMs`; concurrent reads share one call. */
export class GpuCache {
  readonly #read: GpuReader;
  readonly #ttlMs: number;
  #value: GpuSample | null = null;
  #at = Number.NEGATIVE_INFINITY;
  #pending: Promise<GpuSample | null> | null = null;

  constructor(read: GpuReader, ttlMs = 5000) {
    this.#read = read;
    this.#ttlMs = ttlMs;
  }

  /** The last reading, without waiting. */
  get last(): GpuSample | null {
    return this.#value;
  }

  get stale(): boolean {
    return Date.now() - this.#at > this.#ttlMs;
  }

  async read(): Promise<GpuSample | null> {
    if (!this.stale) return this.#value;
    if (this.#pending === null) {
      this.#pending = this.#read()
        .catch(() => null)
        .then((value) => {
          this.#value = value;
          this.#at = Date.now();
          this.#pending = null;
          return value;
        });
    }
    return this.#pending;
  }
}
