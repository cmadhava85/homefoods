#!/usr/bin/env node
/**
 * Lightweight static security guardrails for CI.
 * Fails on known footguns; complements npm audit + API security tests.
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const failures = [];

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === "dist" || name === ".git" || name === ".next") continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(p);
  }
  return out;
}

const files = walk(join(root, "apps")).concat(walk(join(root, "packages")));

const banned = [
  {
    re: /cors\(\s*\{\s*origin:\s*true/i,
    msg: "CORS origin:true is forbidden — use an allow-list",
  },
  {
    re: /Access-Control-Allow-Origin['"]\s*,\s*['"]\*/,
    msg: "Wildcard ACAO is forbidden",
  },
  {
    re: /AUTH_ENFORCE\s*=\s*['"]false['"].*production|NODE_ENV.*production[\s\S]{0,80}AUTH_ENFORCE.*false/i,
    msg: "Do not hard-code AUTH_ENFORCE=false for production",
  },
];

for (const file of files) {
  const rel = relative(root, file);
  // Allow docs/examples and this script
  if (rel.includes("scripts/security-check")) continue;
  const text = readFileSync(file, "utf8");
  for (const rule of banned) {
    if (rule.re.test(text)) {
      failures.push(`${rel}: ${rule.msg}`);
    }
  }
}

// Assert production config module still refuses mocks
const prodConfig = readFileSync(join(root, "apps/api/src/prodConfig.ts"), "utf8");
if (!prodConfig.includes("MOCK_PAYMENTS") || !prodConfig.includes("AUTH_SECRET")) {
  failures.push("apps/api/src/prodConfig.ts: missing expected production guards");
}

// assertAuthed must stay fail-closed (no soft return of currentUser without requireRole)
const authCtx = readFileSync(join(root, "apps/api/src/http/authContext.ts"), "utf8");
if (/function assertAuthed[\s\S]*?if\s*\(\s*!authEnforced\(\)\s*\)\s*return\s+currentUser/.test(authCtx)) {
  failures.push("http/authContext.ts: assertAuthed must not soft-open when authEnforced is false");
}

if (failures.length) {
  console.error("security-check failed:\n" + failures.map((f) => ` - ${f}`).join("\n"));
  process.exit(1);
}

console.log(`security-check ok (${files.length} files scanned)`);
