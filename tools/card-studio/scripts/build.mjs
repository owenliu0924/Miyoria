// `vite build`, but only where Live2D's files were fetched (vendor.md). They are not in git, so a
// fresh checkout (CI, a machine that never renders cards) has nothing to build: say so and stop.
//
// Three builds: the page the headless browser opens (`dist/`), `src/render.ts` for Node
// (`dist/node/render.js`, playwright-core left as an import), which the Core loads from this folder
// when `[modules.cards] portrait = "live2d"`, and her figure for the room's page
// (`dist/figure/figure.js`, `vite.figure.config.ts`), which the Core serves to members' browsers.
// `node scripts/build.mjs figure` builds only the figure.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const needed = ["vendor/live2dcubismcore.min.js", "vendor/framework/src"];
const missing = needed.filter((p) => !existsSync(join(root, p)));
if (missing.length > 0) {
  console.log(
    `card-studio: skipped, Live2D files missing (${missing.join(", ")}); see vendor.md to fetch them`,
  );
  process.exit(0);
}
const vite = (args) => spawnSync("vite", args, { cwd: root, stdio: "inherit", shell: true });
const only = process.argv[2];
if (only !== "figure") {
  // The page empties `dist/` first, so it goes before the other two.
  const page = vite(["build"]);
  if (page.status !== 0) process.exit(page.status ?? 1);
  const node = vite([
    "build",
    "--ssr",
    "src/render.ts",
    "--outDir",
    "dist/node",
    "--emptyOutDir",
    "false",
  ]);
  if (node.status !== 0) process.exit(node.status ?? 1);
}
// The bundle empties `dist/figure/` first; the worker's script goes beside it.
const figure = vite(["build", "--config", "vite.figure.config.ts"]);
if (figure.status !== 0) process.exit(figure.status ?? 1);
const worker = vite(["build", "--config", "vite.figure-worker.config.ts"]);
process.exit(worker.status ?? 1);
