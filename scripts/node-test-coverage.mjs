#!/usr/bin/env node
/**
 * Run a workspace's node:test suite with built-in coverage and enforce thresholds (Node ≥ 22.8).
 * Writes coverage/lcov.info (for CI artifacts / Codecov / Sonar) and prints the text table.
 *
 *   node ../../scripts/node-test-coverage.mjs --lines 95 --branches 90 --functions 90 [--serial]
 *
 * Run from the workspace directory. Test files: every *.test.ts under ./src.
 * Workspace packages, dist output, node_modules and the tests themselves are excluded.
 */
import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const opt = (name) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) collect(p, out);
    else if (name.endsWith(".test.ts")) out.push(p);
  }
  return out;
}

const files = collect("src").sort();
if (!files.length) {
  console.error("No *.test.ts files under src/");
  process.exit(1);
}
mkdirSync("coverage", { recursive: true });

const thresholds = ["lines", "branches", "functions"]
  .filter((k) => opt(k) != null)
  .map((k) => `--test-coverage-${k}=${opt(k)}`);

const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    "--test",
    ...(args.includes("--serial") ? ["--test-concurrency=1"] : []),
    "--experimental-test-coverage",
    "--test-coverage-exclude=**/*.test.ts",
    "--test-coverage-exclude=**/node_modules/**",
    "--test-coverage-exclude=**/dist/**",
    "--test-coverage-exclude=../../packages/**",
    "--test-coverage-exclude=src/testHelpers.ts",
    ...thresholds,
    "--test-reporter=spec",
    "--test-reporter-destination=stdout",
    "--test-reporter=lcov",
    "--test-reporter-destination=coverage/lcov.info",
    ...files,
  ],
  { stdio: "inherit", env: process.env },
);
process.exit(result.status ?? 1);
