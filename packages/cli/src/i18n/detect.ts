// Which language a run uses: `--lang`, then `MIYORIA_LANG`, then the locale of the system
// (`LC_ALL`, `LC_MESSAGES`, `LANG`, and where none is set, the locale Node reports, which on
// Windows is the display language). Traditional Chinese locales (zh-TW, zh-HK, zh-MO, zh-Hant)
// choose Traditional Chinese; every other locale, Simplified Chinese included, chooses English.

import type { Lang } from "./index.js";

/** A value of `--lang` or `MIYORIA_LANG` naming a language exactly: `en`, `zh-TW` (any case, `_` or `-`). */
export function parseLang(value: string): Lang | undefined {
  const v = value.trim().toLowerCase().replace(/_/g, "-");
  if (v === "en") return "en";
  if (v === "zh-tw") return "zh-TW";
  return undefined;
}

/** The language for a locale name: `zh_TW.UTF-8`, `zh-Hant-HK`, `en-US`, `C` ... */
export function langOfLocale(locale: string): Lang {
  const base = locale.trim().toLowerCase().split(/[.@]/)[0] ?? "";
  const parts = base.replace(/_/g, "-").split("-");
  if (parts[0] !== "zh") return "en";
  if (parts.includes("hant")) return "zh-TW";
  if (parts.includes("hans")) return "en";
  return parts.some((p) => p === "tw" || p === "hk" || p === "mo") ? "zh-TW" : "en";
}

/** The value given to `--lang` (`--lang zh-TW` or `--lang=zh-TW`), if any; `--` ends the options. */
export function langFlag(argv: readonly string[]): string | undefined {
  let found: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i] as string;
    if (token === "--") break;
    if (token === "--lang") found = argv[i + 1] ?? "";
    else if (token.startsWith("--lang=")) found = token.slice("--lang=".length);
  }
  return found;
}

/** The locale Node reports (ICU's default: the Windows display language, the POSIX locale elsewhere). */
export function systemLocale(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().locale;
  } catch {
    return "";
  }
}

export interface LangSources {
  /** The value of `--lang`, already checked with `parseLang`. */
  flag?: Lang | undefined;
  env: Readonly<Record<string, string | undefined>>;
  /** The locale when no environment variable names one (default: `systemLocale`). */
  system?: () => string;
}

/** The language of this run. */
export function detectLang(sources: LangSources): Lang {
  if (sources.flag !== undefined) return sources.flag;
  const { env } = sources;
  const chosen = env.MIYORIA_LANG?.trim();
  if (chosen) return parseLang(chosen) ?? langOfLocale(chosen);
  for (const name of ["LC_ALL", "LC_MESSAGES", "LANG"]) {
    const value = env[name]?.trim();
    if (value) return langOfLocale(value);
  }
  return langOfLocale((sources.system ?? systemLocale)());
}
