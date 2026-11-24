#!/usr/bin/env node
/**
 * Blocking npm audit gate for CI: fails on any high/critical advisory in production deps that is
 * not in security/audit-allowlist.json, and on allowlist entries that have expired.
 *
 *   node scripts/audit-gate.mjs
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const allowlist = JSON.parse(readFileSync(join(root, "security/audit-allowlist.json"), "utf8")).entries;

let raw;
try {
  raw = execFileSync("npm", ["audit", "--omit=dev", "--json"], { cwd: root, encoding: "utf8" });
} catch (err) {
  // npm audit exits non-zero when it finds anything; the JSON is still on stdout.
  raw = err.stdout;
  if (!raw) {
    console.error("[audit-gate] npm audit produced no output", err.message);
    process.exit(2);
  }
}

const report = JSON.parse(raw);
const today = new Date().toISOString().slice(0, 10);
const problems = [];

for (const e of allowlist) {
  if (!e.package || !e.expires || !e.reason) problems.push(`allowlist entry incomplete: ${JSON.stringify(e)}`);
  else if (e.expires < today) problems.push(`allowlist entry for ${e.package} expired on ${e.expires} — upgrade or re-review`);
}

const allowed = new Map(allowlist.map((e) => [e.package, e]));
const blocking = Object.entries(report.vulnerabilities ?? {}).filter(
  ([, v]) => v.severity === "high" || v.severity === "critical",
);
for (const [name, v] of blocking) {
  if (!allowed.has(name)) problems.push(`${v.severity}: ${name} (${v.range}) is not in security/audit-allowlist.json`);
}

const counts = report.metadata?.vulnerabilities ?? {};
console.log(
  `[audit-gate] prod deps: critical ${counts.critical ?? 0}, high ${counts.high ?? 0} (${blocking.length - problems.filter((p) => p.includes("not in")).length} allowlisted), moderate ${counts.moderate ?? 0}`,
);
if (problems.length) {
  for (const p of problems) console.error(`[audit-gate] ${p}`);
  process.exit(1);
}
console.log("[audit-gate] OK");
