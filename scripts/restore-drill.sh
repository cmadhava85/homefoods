#!/usr/bin/env bash
# Quarterly PITR restore drill: clone localmeals-pg → timestamped instance, row-count checks, delete.
#
#   ./scripts/restore-drill.sh              # clone + checks; leaves clone running
#   ./scripts/restore-drill.sh --confirm    # same, then deletes the clone
#
# Env: GCP_PROJECT_ID, GCP_REGION, NAME_PREFIX, PITR_TIME (RFC3339 UTC, default = now−1h),
#      PGPASSWORD or DATABASE_URL_DRILL (for psql checks), PROXY_PORT (default 15432)
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-home-food-513806}"
REGION="${GCP_REGION:-asia-south1}"
PREFIX="${NAME_PREFIX:-localmeals}"
SOURCE="${PREFIX}-pg"
STAMP="$(date -u +%Y%m%d%H%M%S)"
CLONE="${PREFIX}-pg-drill-${STAMP}"
CONFIRM=false
PROXY_PORT="${PROXY_PORT:-15432}"
DB_USER="${DB_USER:-localmeals}"
DB_NAME="${DB_NAME:-localmeals}"

# macOS date -v / GNU date -d
if [[ -z "${PITR_TIME:-}" ]]; then
  if PITR_TIME="$(date -u -v-1H +%Y-%m-%dT%H:%M:%SZ 2>/dev/null)"; then
    :
  else
    PITR_TIME="$(date -u -d '1 hour ago' +%Y-%m-%dT%H:%M:%SZ)"
  fi
fi

for arg in "$@"; do
  case "$arg" in
    --confirm) CONFIRM=true ;;
    -h|--help)
      sed -n '2,10p' "$0"
      exit 0
      ;;
    *)
      echo "Unknown arg: $arg (use --confirm)" >&2
      exit 2
      ;;
  esac
done

START_EPOCH="$(date +%s)"
echo "==> Project $PROJECT_ID · region $REGION · source $SOURCE · clone $CLONE · PITR $PITR_TIME"

gcloud config set project "$PROJECT_ID" >/dev/null

echo "==> Cloning (PITR)…"
gcloud sql instances clone "$SOURCE" "$CLONE" \
  --point-in-time="$PITR_TIME" \
  --quiet

echo "==> Waiting until RUNNABLE…"
STATE=""
for _ in $(seq 1 90); do
  STATE="$(gcloud sql instances describe "$CLONE" --format='value(state)' 2>/dev/null || true)"
  if [[ "$STATE" == "RUNNABLE" ]]; then
    break
  fi
  echo "    state=${STATE:-unknown} …"
  sleep 20
done
STATE="$(gcloud sql instances describe "$CLONE" --format='value(state)')"
if [[ "$STATE" != "RUNNABLE" ]]; then
  echo "Clone not RUNNABLE (state=$STATE). Delete manually if needed:" >&2
  echo "  gcloud sql instances delete $CLONE --quiet" >&2
  exit 1
fi

CONN="$(gcloud sql instances describe "$CLONE" --format='value(connectionName)')"
echo "==> connectionName=$CONN"

PROXY_PID=""
cleanup_proxy() {
  if [[ -n "${PROXY_PID}" ]] && kill -0 "$PROXY_PID" 2>/dev/null; then
    kill "$PROXY_PID" 2>/dev/null || true
    wait "$PROXY_PID" 2>/dev/null || true
  fi
}
trap cleanup_proxy EXIT

if command -v cloud-sql-proxy >/dev/null 2>&1; then
  echo "==> Starting cloud-sql-proxy on 127.0.0.1:${PROXY_PORT}"
  cloud-sql-proxy --port "$PROXY_PORT" "$CONN" &
  PROXY_PID=$!
  sleep 3

  if [[ -z "${DATABASE_URL_DRILL:-}" && -z "${PGPASSWORD:-}" ]]; then
    echo "Set PGPASSWORD (or DATABASE_URL_DRILL) to run row-count checks via psql. Skipping SQL checks."
  elif ! command -v psql >/dev/null 2>&1; then
    echo "psql not installed — skip SQL checks."
  else
    echo "==> Row counts"
    run_sql() {
      if [[ -n "${DATABASE_URL_DRILL:-}" ]]; then
        psql "$DATABASE_URL_DRILL" -v ON_ERROR_STOP=1 -At -c "$1"
      else
        PGPASSWORD="${PGPASSWORD}" psql -h 127.0.0.1 -p "$PROXY_PORT" -U "$DB_USER" -d "$DB_NAME" \
          -v ON_ERROR_STOP=1 -At -c "$1"
      fi
    }
    for table in orders payments refunds settlements; do
      count="$(run_sql "SELECT count(*) FROM ${table};" || echo ERR)"
      echo "    ${table}: ${count}"
    done
    latest="$(run_sql "SELECT coalesce(max(created_at)::text, 'null') FROM orders;" || echo ERR)"
    echo "    orders.max(created_at): ${latest}"
  fi
else
  echo "cloud-sql-proxy not installed — skip SQL checks (install Cloud SQL Auth Proxy)."
fi

ELAPSED=$(( $(date +%s) - START_EPOCH ))
echo "==> Elapsed: ${ELAPSED}s (target RTO < 3600s)"
echo "Record in docs/RUNBOOK.md §13 Restore drill log: date, who, RTO=${ELAPSED}s, issues."

if [[ "$CONFIRM" == true ]]; then
  echo "==> --confirm: deleting clone ${CLONE}"
  cleanup_proxy
  trap - EXIT
  gcloud sql instances delete "$CLONE" --quiet
  echo "Deleted."
else
  echo "Clone left running: ${CLONE}"
  echo "Delete when finished:"
  echo "  gcloud sql instances delete ${CLONE} --quiet"
fi
