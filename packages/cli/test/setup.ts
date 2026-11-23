// Every test runs in English: `main` reads `MIYORIA_LANG` (set in `vitest.config.ts`), and the
// active catalogue is reset before each test. A test of the other language sets it itself.

import { beforeEach } from "vitest";
import { setLang } from "../src/i18n/index.js";

beforeEach(() => {
  setLang("en");
});
