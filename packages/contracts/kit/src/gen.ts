// `pnpm contracts:gen`: writes schema/<part>.json for every part, and removes files of parts that
// no longer exist. The files are checked in; kit/test/parts.test.ts fails when one is stale.

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkRules, emitPart, formatDocument } from "./index.js";
import { loadPart, partNames, SCHEMA_DIR, schemaFile } from "./parts.js";

async function main(): Promise<number> {
  mkdirSync(SCHEMA_DIR, { recursive: true });
  const kept = new Set<string>();
  let failed = false;
  for (const name of partNames()) {
    const part = await loadPart(name);
    const problems = checkRules(name, part);
    for (const problem of problems) process.stderr.write(`${name}: ${problem}\n`);
    if (problems.length > 0) {
      failed = true;
      continue;
    }
    const document = emitPart(name, part);
    if (document === null) continue;
    const file = schemaFile(name);
    const text = formatDocument(document);
    kept.add(`${name}.json`);
    if (existsSync(file) && readFileSync(file, "utf8") === text) continue;
    writeFileSync(file, text);
    process.stdout.write(`wrote schema/${name}.json\n`);
  }
  if (failed) return 1;
  for (const entry of readdirSync(SCHEMA_DIR)) {
    if (!entry.endsWith(".json") || kept.has(entry)) continue;
    rmSync(join(SCHEMA_DIR, entry));
    process.stdout.write(`removed schema/${entry}\n`);
  }
  return 0;
}

process.exitCode = await main();
