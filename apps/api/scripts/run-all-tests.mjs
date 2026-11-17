import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");

function collectTests(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collectTests(p, out);
    else if (name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = collectTests(join(root, "src")).sort();
if (!files.length) {
  console.error("No test files found under src/");
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ["--import", "tsx", "--test", "--test-concurrency=1", ...files],
  { cwd: root, stdio: "inherit", env: process.env },
);

process.exit(result.status ?? 1);
