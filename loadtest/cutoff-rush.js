/**
 * k6 load test — the pre-cut-off lunch rush.
 *
 *   browse  : anonymous users opening kitchens + menus (safe against any environment)
 *   order   : signed-in customers placing an order (ONLY when ALLOW_WRITES=true and the target runs
 *             MOCK_AUTH=true + MOCK_PAYMENTS=true — i.e. local or a disposable staging copy)
 *
 * Run (Docker, no install):
 *   docker run --rm -i -e BASE_URL=http://host.docker.internal:4000 grafana/k6 run - < loadtest/cutoff-rush.js
 *   docker run --rm -i -e BASE_URL=... -e ALLOW_WRITES=true -e PEAK_VUS=60 grafana/k6 run - < loadtest/cutoff-rush.js
 *
 * Note: every VU shares the k6 machine IP, so anonymous per-IP rate limits (OTP 120/15 min with mock auth,
 * global RATE_LIMIT_MAX/min) apply to the whole test. Raise RATE_LIMIT_MAX on the target for capacity runs.
 */
import http from "k6/http";
import { check, group, sleep } from "k6";
import { Counter, Trend } from "k6/metrics";

const BASE = (__ENV.BASE_URL || "http://127.0.0.1:4000").replace(/\/$/, "");
const SLUG = __ENV.KITCHEN_SLUG || "csk-homemade-delights";
const PEAK = Number(__ENV.PEAK_VUS || 50);
const WRITES = __ENV.ALLOW_WRITES === "true";

const orderLatency = new Trend("order_create_ms", true);
const ordersCreated = new Counter("orders_created");
const soldOut = new Counter("orders_rejected_capacity");

const QUICK = __ENV.QUICK === "true"; // ~30 s smoke of the script itself
const ramp = [
  { duration: QUICK ? "5s" : "30s", target: Math.ceil(PEAK / 5) },
  { duration: QUICK ? "10s" : "1m", target: PEAK }, // last minutes before cut-off
  { duration: QUICK ? "10s" : "2m", target: PEAK },
  { duration: QUICK ? "5s" : "30s", target: 0 },
];

export const options = {
  scenarios: {
    browse: { executor: "ramping-vus", exec: "browse", stages: ramp },
    ...(WRITES
      ? {
          order: {
            executor: "ramping-vus",
            exec: "order",
            stages: ramp.map((s) => ({ ...s, target: Math.ceil(s.target / 3) })),
          },
        }
      : {}),
  },
  thresholds: {
    http_req_failed: ["rate<0.01"],
    "http_req_duration{kind:read}": ["p(95)<500", "p(99)<1500"],
    ...(WRITES ? { order_create_ms: ["p(95)<1500"] } : {}),
  },
};

const json = { headers: { "Content-Type": "application/json" } };
// Business outcomes that are not failures (sold out / closed) must not count as http_req_failed.
http.setResponseCallback(http.expectedStatuses({ min: 200, max: 399 }, 409));

export function browse() {
  group("browse", () => {
    const tags = { kind: "read" };
    const list = http.get(`${BASE}/kitchens`, { tags });
    check(list, { "kitchens 200": (r) => r.status === 200 });
    const menu = http.get(`${BASE}/kitchens/${SLUG}/menu`, { tags });
    check(menu, { "menu 200": (r) => r.status === 200 });
    http.get(`${BASE}/kitchens/${SLUG}/week`, { tags });
    http.get(`${BASE}/meta/features`, { tags });
  });
  sleep(1 + Math.random() * 3);
}

function vuMobile() {
  // +91 7xxxxxxxxx — unique per VU, stable across iterations.
  return `+917${String(100000000 + __VU * 7919).slice(-9)}`;
}

let session = null;

function login() {
  const mobile = vuMobile();
  const req = http.post(`${BASE}/auth/otp/request`, JSON.stringify({ mobile, role: "CUSTOMER" }), json);
  if (req.status !== 200) return null;
  const code = req.json("mockCode") || "123456";
  const ver = http.post(
    `${BASE}/auth/otp/verify`,
    JSON.stringify({ mobile, role: "CUSTOMER", code }),
    json,
  );
  if (ver.status !== 200) return null;
  const headers = { "Content-Type": "application/json", Authorization: `Bearer ${ver.json("token")}` };
  const addr = http.post(
    `${BASE}/me/addresses`,
    JSON.stringify({ label: "HOME", line1: `Load test tower ${__VU}`, pinCode: "600119", isDefault: true }),
    { headers },
  );
  const addressId = addr.status < 300 ? addr.json("id") : null;
  return { mobile, headers, addressId };
}

export function order() {
  if (!session) session = login();
  if (!session) {
    sleep(5);
    return;
  }
  const menu = http.get(`${BASE}/kitchens/${SLUG}/menu`, { tags: { kind: "read" } });
  const item = menu.status === 200 ? (menu.json("menus") || [])[0] : null;
  if (!item) {
    sleep(2);
    return;
  }
  const res = http.post(
    `${BASE}/orders`,
    JSON.stringify({
      customerMobile: session.mobile,
      cookSlug: SLUG,
      menuItemId: item.id,
      qty: 1,
      spice: "NORMAL",
      addressId: session.addressId,
    }),
    { headers: session.headers, tags: { kind: "write" } },
  );
  orderLatency.add(res.timings.duration);
  if (res.status === 200) {
    ordersCreated.add(1);
    // Release the hold so capacity is not exhausted by the test itself.
    http.post(`${BASE}/orders/${res.json("publicId")}/cancel`, null, { headers: session.headers });
  } else if (res.status === 409 || res.status === 400) {
    soldOut.add(1);
  }
  check(res, { "order accepted or cleanly rejected": (r) => [200, 400, 409].includes(r.status) });
  sleep(2 + Math.random() * 4);
}
