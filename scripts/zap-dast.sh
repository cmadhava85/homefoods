#!/usr/bin/env bash
# Free OWASP ZAP DAST against a local/CI LocalMeals API (never production).
# Requires: Docker, API listening on TARGET (default http://host.docker.internal:4000).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
TARGET="${ZAP_TARGET:-http://host.docker.internal:4000}"
REPORT_DIR="${ZAP_REPORT_DIR:-$ROOT/reports/zap}"
ZAP_IMAGE="${ZAP_IMAGE:-ghcr.io/zaproxy/zaproxy:stable}"
MODE="${1:-baseline}" # baseline | api | both

mkdir -p "$REPORT_DIR"

# From the host, prefer localhost for the wait loop; containers still use TARGET
# (host.docker.internal → host API).
HEALTH_URLS=("${TARGET%/}/health")
if [[ "$TARGET" == *"host.docker.internal"* ]]; then
  HEALTH_URLS+=("http://127.0.0.1:4000/health" "http://localhost:4000/health")
fi

echo "==> Waiting for API health (target for ZAP: $TARGET)"
ok=0
for _ in $(seq 1 45); do
  for hu in "${HEALTH_URLS[@]}"; do
    if curl -sf "$hu" >/dev/null 2>&1; then
      ok=1
      echo "    healthy via $hu"
      break 2
    fi
  done
  sleep 1
done
if [[ "$ok" != "1" ]]; then
  echo "API not healthy — start it first (npm run dev:api). Tried: ${HEALTH_URLS[*]}" >&2
  exit 1
fi

# Docker Desktop / Linux host gateway for container → host API
DOCKER_EXTRA=(--rm -v "$ROOT:/zap/wrk:rw" -t)
if docker info 2>/dev/null | grep -qi 'operating system.*docker desktop\|osType.*darwin'; then
  DOCKER_EXTRA+=(--add-host=host.docker.internal:host-gateway)
elif [[ "$(uname -s)" == "Linux" ]]; then
  DOCKER_EXTRA+=(--add-host=host.docker.internal:host-gateway)
  # Also try host network for CI Linux runners when TARGET is localhost
  if [[ "$TARGET" == http://localhost:* ]] || [[ "$TARGET" == http://127.0.0.1:* ]]; then
    DOCKER_EXTRA+=(--network=host)
    TARGET="http://127.0.0.1:${TARGET##*:}"
  fi
fi

run_baseline() {
  echo "==> ZAP baseline (passive) → $TARGET"
  # Paths are relative to the container workdir (/zap/wrk = repo root).
  # -I: do not fail the process on WARN (CI still uploads reports)
  docker run "${DOCKER_EXTRA[@]}" -w /zap/wrk "$ZAP_IMAGE" zap-baseline.py \
    -t "$TARGET" \
    -c .zap/rules.tsv \
    -m 2 \
    -a \
    -I \
    -J reports/zap/baseline.json \
    -r reports/zap/baseline.html \
    -w reports/zap/baseline.md \
    || {
      code=$?
      echo "ZAP baseline exit $code (1=FAIL alerts, 2=WARN only, 3=other)"
      return "$code"
    }
}

run_api() {
  echo "==> ZAP API scan (OpenAPI) → apps/api/openapi.json"
  # -O needs a full URL with scheme (newer ZAP). Soften WARNs with -I.
  docker run "${DOCKER_EXTRA[@]}" -w /zap/wrk "$ZAP_IMAGE" zap-api-scan.py \
    -t apps/api/openapi.json \
    -f openapi \
    -O "$TARGET" \
    -c .zap/rules.tsv \
    -I \
    -J reports/zap/api-scan.json \
    -r reports/zap/api-scan.html \
    -w reports/zap/api-scan.md \
    || {
      code=$?
      echo "ZAP API scan exit $code (1=FAIL alerts, 2=WARN only, 3=other)"
      return "$code"
    }
}

exit_code=0
case "$MODE" in
  baseline) run_baseline || exit_code=$? ;;
  api) run_api || exit_code=$? ;;
  both)
    run_baseline || exit_code=$?
    run_api || true
    ;;
  *)
    echo "Usage: $0 [baseline|api|both]" >&2
    exit 1
    ;;
esac

echo "==> Reports in $REPORT_DIR"
exit "$exit_code"
