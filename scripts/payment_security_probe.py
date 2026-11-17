#!/usr/bin/env python3
"""
Defensive payment security probe for LocalMeals (NOT a penetration / exploit kit).

Verifies that a running API *rejects* forged payment webhooks, unauthorized admin
payout actions, and client-only "I paid" claims. Exit 0 only if all checks pass.

Usage (API must be up):
  python3 scripts/payment_security_probe.py
  API_URL=http://127.0.0.1:4000 python3 scripts/payment_security_probe.py

Safety:
  - Defaults to localhost only
  - Refuses public/prod hosts unless ALLOW_REMOTE_PROBE=1
  - Does not brute-force secrets or send exploit payloads
"""

from __future__ import annotations

import json
import os
import sys
import urllib.error
import urllib.request
from typing import Any
from urllib.parse import urlparse

DEFAULT_URL = "http://127.0.0.1:4000"


def base_url() -> str:
    return (os.environ.get("API_URL") or DEFAULT_URL).rstrip("/")


def assert_safe_target(url: str) -> None:
    host = (urlparse(url).hostname or "").lower()
    local = host in {"127.0.0.1", "localhost", "::1"}
    if local:
        return
    if os.environ.get("ALLOW_REMOTE_PROBE") == "1":
        print(f"WARNING: probing non-local API {url} (ALLOW_REMOTE_PROBE=1)")
        return
    print(
        f"Refusing non-local API_URL={url}. "
        "Set ALLOW_REMOTE_PROBE=1 only for your own staging.",
        file=sys.stderr,
    )
    sys.exit(2)


def request(
    method: str,
    path: str,
    *,
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
) -> tuple[int, Any]:
    data = None
    hdrs = {"Accept": "application/json", **(headers or {})}
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        hdrs.setdefault("Content-Type", "application/json")
    req = urllib.request.Request(
        f"{base_url()}{path}",
        data=data,
        headers=hdrs,
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=15) as res:
            raw = res.read().decode("utf-8") or "{}"
            try:
                return res.status, json.loads(raw)
            except json.JSONDecodeError:
                return res.status, raw
    except urllib.error.HTTPError as e:
        raw = e.read().decode("utf-8") or "{}"
        try:
            return e.code, json.loads(raw)
        except json.JSONDecodeError:
            return e.code, raw
    except urllib.error.URLError as e:
        raise SystemExit(
            f"Cannot reach API at {base_url()} ({e.reason}). Start it with: npm run dev:api"
        ) from e

def expect(name: str, ok: bool, detail: str) -> bool:
    status = "PASS" if ok else "FAIL"
    print(f"[{status}] {name}: {detail}")
    return ok


def main() -> int:
    url = base_url()
    assert_safe_target(url)
    print(f"Payment security probe → {url}\n")

    results: list[bool] = []

    code, body = request("GET", "/health")
    results.append(expect("health", code == 200 and body.get("ok") is True, f"{code} {body}"))

    # Forged Razorpay webhook (bad HMAC) must not be accepted as paid.
    code, body = request(
        "POST",
        "/webhooks/payments",
        headers={"X-Razorpay-Signature": "0" * 64},
        body={
            "event": "payment_link.paid",
            "payload": {
                "payment_link": {"entity": {"id": "plink_probe_forged", "amount": 1}},
                "payment": {"entity": {"id": "pay_probe_forged", "amount": 1}},
            },
        },
    )
    # Mock mode may accept unsigned webhooks locally; live mode must 401.
    mock_off = os.environ.get("MOCK_PAYMENTS") == "false"
    if mock_off:
        results.append(
            expect(
                "webhook forged signature (live)",
                code == 401,
                f"expected 401, got {code} {body}",
            )
        )
    else:
        results.append(
            expect(
                "webhook forged signature (mock note)",
                code in {200, 401, 400},
                f"MOCK_PAYMENTS not false — got {code} (set MOCK_PAYMENTS=false to assert 401)",
            )
        )

    # Mock confirm must never accept a live-looking plink id.
    code, body = request(
        "POST",
        "/payments/mock-confirm",
        body={"gatewayTxnId": "plink_should_not_mock_confirm"},
    )
    results.append(
        expect(
            "mock-confirm rejects non-mock id",
            code in {400, 403},
            f"{code} {body}",
        )
    )

    # Client cannot force paid via confirm-return claim alone (unknown order → 404;
    # known unpaid order must not become PAID — covered in API security.test.ts).
    code, body = request(
        "POST",
        "/payments/confirm-return",
        body={
            "publicId": "LM-DOES-NOT-EXIST",
            "linkStatus": "paid",
            "paymentId": "pay_client_claim",
        },
    )
    results.append(
        expect(
            "confirm-return unknown order",
            code == 404,
            f"{code} {body}",
        )
    )

    # Admin payout path must require auth.
    code, body = request(
        "POST",
        "/admin/settlements/1/manual-pay",
        body={"utr": "PROBE-UTR"},
    )
    results.append(
        expect(
            "admin manual-pay unauthenticated",
            code in {401, 403},
            f"{code} {body}",
        )
    )

    # Internal EOD must not run without token when INTERNAL_JOB_TOKEN is set.
    code, body = request("POST", "/internal/settlements/eod", body={})
    results.append(
        expect(
            "internal EOD without token",
            code in {401, 403, 400} or (code == 200 and os.environ.get("INTERNAL_JOB_TOKEN") in (None, "")),
            f"{code} {body}",
        )
    )

    failed = sum(1 for r in results if not r)
    print(f"\n{len(results) - failed}/{len(results)} checks passed")
    if failed:
        print(
            "\nAlso run in-process suite: npm test -w @localmeals/api "
            "(security.test.ts payment cases).",
            file=sys.stderr,
        )
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
