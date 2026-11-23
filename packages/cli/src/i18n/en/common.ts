// Words and formats shared by every command.

/** Thousands separators, the same in both languages: `24,564`. */
const int = (n: number): string => Math.round(n).toLocaleString("en-US");

export const common = {
  /** `asr, tts, turn` */
  list: (items: readonly string[]): string => items.join(", "),
  /** An empty list or value in running text. */
  none: "(none)",
  yes: "Yes",
  no: "No",
  cancelled: "Cancelled",
  set: "set",
  notSet: "not set",
  /** A whole number with thousands separators. */
  int,
  /** Megabytes: `24,564 MB`. */
  mb: (mb: number): string => `${int(mb)} MB`,
  /** Gigabytes with one decimal: `1.5 GB`. */
  gb: (gb: number): string => `${gb.toFixed(1)} GB`,
  /** A duration: `12 s`, `5 min`, `3 h`, `2 d` (whole units, rounded down). */
  duration: (seconds: number): string => {
    const s = Math.max(0, Math.floor(seconds));
    if (s < 60) return `${s} s`;
    if (s < 3600) return `${Math.floor(s / 60)} min`;
    if (s < 86_400) return `${Math.floor(s / 3600)} h`;
    return `${Math.floor(s / 86_400)} d`;
  },
  /** How long ago: `5 min ago`. */
  ago: (seconds: number): string => `${common.duration(seconds)} ago`,
  /** Seconds as a count: `30 seconds`, `1 second`. */
  seconds: (n: number): string => `${n} ${n === 1 ? "second" : "seconds"}`,
  /** Minutes as a count: `10 minutes`. */
  minutes: (n: number): string => `${n} ${n === 1 ? "minute" : "minutes"}`,
  /** `3 services`, `1 service`. */
  services: (n: number): string => `${n} ${n === 1 ? "service" : "services"}`,
  /** `2 files`, `1 file`. */
  files: (n: number): string => `${n} ${n === 1 ? "file" : "files"}`,
};
