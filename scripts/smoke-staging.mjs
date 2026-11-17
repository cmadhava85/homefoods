#!/usr/bin/env node
/**
 * Staging / live-loop HTTP smoke against a deployed (or local) API.
 *
 * Usage:
 *   SMOKE_API_URL=https://localmeals-api-….run.app node scripts/smoke-staging.mjs
 *   node scripts/smoke-staging.mjs   # defaults to http://127.0.0.1:4000
 *
 * Does not mutate data or require credentials — checks health, public browse,
 * and that protected routes reject anonymous callers.
 */
import { config } from "dotenv";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
config({ path: resolve(root, ".env"), override: false });

const base = (process.env.SMOKE_API_URL ?? process.env.NEXT_PUBLIC_API_URL ?? "http://127.0.0.1:4000").replace(
  /\/$/,
  "",
);

const results = [];
function ok(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail ? " — " + detail : ""}`);
}

async function req(path, init = {}) {
  const res = await fetch(`${base}${path}`, {
    ...init,
    headers: {
      Accept: "application/json",
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { status: res.status, body, headers: res.headers };
}

console.log(`Smoke target: ${base}\n`);

try {
  const health = await req("/health");
  ok("GET /health", health.status === 200 && health.body?.ok === true, `status=${health.status}`);

  const today = await req("/meta/today");
  ok(
    "GET /meta/today",
    today.status === 200 && typeof today.body?.serviceDate === "string",
    `status=${today.status}`,
  );

  const features = await req("/meta/features");
  ok("GET /meta/features", features.status === 200 && features.body != null, `status=${features.status}`);

  const kitchens = await req("/kitchens");
  ok(
    "GET /kitchens",
    kitchens.status === 200 && Array.isArray(kitchens.body),
    `status=${kitchens.status}`,
  );

  const me = await req("/auth/me");
  ok("GET /auth/me anonymous → 401", me.status === 401, `status=${me.status}`);

  const admin = await req("/admin/cooks");
  ok(
    "GET /admin/cooks rejects anonymous",
    admin.status === 401 || admin.status === 403,
    `status=${admin.status}`,
  );

  const uploadsProbe = await req("/uploads/menu-00000000-0000-0000-0000-000000000000.jpg");
  ok(
    "GET /uploads missing → 404",
    uploadsProbe.status === 404,
    `status=${uploadsProbe.status}`,
  );
} catch (err) {
  ok("reachability", false, err instanceof Error ? err.message : String(err));
}

const failed = results.filter((r) => !r.pass).length;
console.log(`\n${results.length - failed}/${results.length} passed`);
process.exit(failed ? 1 : 0);
