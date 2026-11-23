// The language of the CLI's messages: English (the default) or Traditional Chinese.
//
// One typed catalogue per language: `en/` defines every message (a string, or a function of its
// parameters), and `zh-TW/` is typed against it, so a key missing in either language or a
// parameter of the wrong type does not compile (`test/i18n.test.ts` also compares the parameter
// counts). `t` reads the active catalogue when a message is shown, never at import time: nothing
// may read `t` at the top level of a module.
//
// Which language is active is decided once per run by `main` (`detect.ts`).
//
// Terms, the same in every message (English / Traditional Chinese):
//   this machine / 本機            host (any machine known to a Core: `miyoria host`) / 主機
//   Core node (runs Core) / Core 節點   service node (serves a remote Core) / 服務節點
//   host daemon (hostd), on every machine / 主機常駐程式(hostd); "worker" only names the speech
//   and singing service processes that carry it (ASR worker URL, `[stack.workers]`)
//   the character / 角色 (not "she" in setup text)   profile / 角色
//   service / 服務   capability / 能力   invite code / 邀請碼   approve / 核准   revoke / 撤銷
//   admin API / 管理 API   admin panel / 管理面板   GPU / 顯示卡   VRAM / VRAM
//   health check / 健康檢查   port / 埠   log file / 記錄檔   folder / 資料夾   default / 預設
//   singing / 翻唱   live stream / 直播   environment (Python) / 環境   model files / 模型檔
// English: sentence case, no exclamation marks; an error says what failed and what to do next.
// Chinese: Taiwan terms; `、` between list items, `。` between sentences, and `,:;()?!` as the
// rest of the repository writes them. Numbers and units go through `common` (`1,500 MB`, `12 s`).

import { en, type Messages } from "./en/index.js";
import { zhTW } from "./zh-TW/index.js";

export type { Messages } from "./en/index.js";

export const LANGS = ["en", "zh-TW"] as const;
export type Lang = (typeof LANGS)[number];

const CATALOGUES: Record<Lang, Messages> = { en, "zh-TW": zhTW };

let active: Lang = "en";

/** Sets the language of every message shown from now on. */
export function setLang(lang: Lang): void {
  active = lang;
}

/** The active language. */
export function lang(): Lang {
  return active;
}

/** The whole catalogue of a language (tests, and a message needed in a language not active). */
export function catalogue(of: Lang): Messages {
  return CATALOGUES[of];
}

/** The active catalogue: `t.init.modeQuestion`, `t.common.list(names)`. */
export const t: Messages = new Proxy({} as Messages, {
  get: (_target, key) => CATALOGUES[active][key as keyof Messages],
});
