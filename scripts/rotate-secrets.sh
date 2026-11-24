#!/usr/bin/env bash
# Rotate LocalMeals secrets in GCP Secret Manager.
# Never prints secret values. Idempotent: re-runs add a new SM version.
#
# Project: home-food-513806 · region: asia-south1
#
# Usage:
#   ./scripts/rotate-secrets.sh                  # rotate all (prompts for vendor secrets)
#   ./scripts/rotate-secrets.sh AUTH_SECRET      # rotate one
#   ./scripts/rotate-secrets.sh --list
#   printf '%s' "$NEW" | ./scripts/rotate-secrets.sh RAZORPAY_KEY_SECRET --stdin
#
# After rotation: update vendor dashboards → redeploy api/worker → verify → disable old SM versions.
# See docs/RUNBOOK.md §11.
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-home-food-513806}"
REGION="${GCP_REGION:-asia-south1}"
PREFIX="${NAME_PREFIX:-localmeals}"
SQL_INSTANCE="${SQL_INSTANCE:-${PREFIX}-pg}"
SQL_USER="${SQL_USER:-localmeals}"
SQL_DB="${SQL_DB:-localmeals}"

# Secrets Cloud Run mounts that must be rotated after the tfplan leak.
ALL_SECRETS=(
  DATABASE_URL
  INTERNAL_JOB_TOKEN
  AUTH_SECRET
  RAZORPAY_KEY_SECRET
  RAZORPAY_WEBHOOK_SECRET
  WHATSAPP_ACCESS_TOKEN
  WHATSAPP_APP_SECRET
  WHATSAPP_VERIFY_TOKEN
)

SCHEDULER_JOBS=(
  "${PREFIX}-lunch-cutoff"
  "${PREFIX}-breakfast-cutoff"
  "${PREFIX}-dinner-cutoff"
  "${PREFIX}-eod"
  "${PREFIX}-expire-unpaid"
)

FROM_STDIN=0
LIST_ONLY=0
TARGETS=()

usage() {
  cat <<EOF
Usage: $0 [--list] [--stdin] [SECRET ...]

  (no args)     Rotate all secrets listed below
  SECRET ...    Rotate only these Secret Manager ids
  --stdin       Read the new value from stdin (required for vendor-issued secrets
                when not prompting). Never log the value.
  --list        Print secret ids and exit

Secrets: ${ALL_SECRETS[*]}

Env: GCP_PROJECT_ID (default ${PROJECT_ID}), GCP_REGION (${REGION}),
     NAME_PREFIX (${PREFIX}), SQL_INSTANCE, SQL_USER, SQL_DB
EOF
}

log() { printf '%s\n' "$*"; }
err() { printf '%s\n' "$*" >&2; }

require_gcloud() {
  if ! command -v gcloud >/dev/null 2>&1; then
    err "gcloud CLI required"
    exit 1
  fi
  gcloud config set project "$PROJECT_ID" >/dev/null
}

ensure_secret_exists() {
  local name="$1"
  if gcloud secrets describe "$name" --project="$PROJECT_ID" >/dev/null 2>&1; then
    return 0
  fi
  log "  creating secret $name (first time)"
  gcloud secrets create "$name" --project="$PROJECT_ID" --replication-policy=automatic >/dev/null
}

# Add a new version from a bash variable without echoing it.
# Writes via a 0600 temp file; never prints the value.
add_secret_version() {
  local name="$1"
  local value="$2"
  local tmp
  tmp="$(mktemp)"
  chmod 600 "$tmp"
  # Prefer python so binary/UTF-8 values stay intact and set -x cannot leak the pipe.
  TMP_PATH="$tmp" SECRET_VALUE="$value" python3 - <<'PY'
import os, pathlib
pathlib.Path(os.environ["TMP_PATH"]).write_text(os.environ["SECRET_VALUE"], encoding="utf-8")
PY
  unset SECRET_VALUE
  ensure_secret_exists "$name"
  gcloud secrets versions add "$name" \
    --project="$PROJECT_ID" \
    --data-file="$tmp" \
    >/dev/null
  rm -f "$tmp"
  log "  OK  $name — new version added (value not shown)"
}

generate_token() {
  # 48 hex chars (~192 bits); openssl always available with gcloud tooling.
  openssl rand -hex 24
}

urlencode_password() {
  # URL-encode for postgres:// userinfo (password may contain specials).
  PASSWORD_RAW="$1" python3 - <<'PY'
import os, urllib.parse
print(urllib.parse.quote(os.environ["PASSWORD_RAW"], safe=""))
PY
}

follow_up() {
  local name="$1"
  case "$name" in
    DATABASE_URL)
      cat <<EOF
  → Follow-up: redeploy api + worker so they pick :latest DATABASE_URL.
     Smoke: /health and a DB-backed /ready (or admin order lookup).
EOF
      ;;
    INTERNAL_JOB_TOKEN)
      cat <<EOF
  → Follow-up: Cloud Scheduler X-Internal-Token headers updated by this script when jobs exist.
     If a job was missing, set header manually then redeploy api/worker.
     Verify: gcloud scheduler jobs run ${PREFIX}-lunch-cutoff --location=${REGION}
EOF
      ;;
    AUTH_SECRET)
      cat <<EOF
  → Follow-up: redeploy api (sessions invalidate). Users must sign in again.
EOF
      ;;
    RAZORPAY_KEY_SECRET)
      cat <<EOF
  → Follow-up (vendor): Razorpay Dashboard → API Keys — generate/regenerate Key Secret,
     then store the new secret here (if you rotated SM first with a placeholder, replace again).
     Keep Key Id in sync with RAZORPAY_KEY_ID. Redeploy api/worker. Test a small order.
EOF
      ;;
    RAZORPAY_WEBHOOK_SECRET)
      cat <<EOF
  → Follow-up (vendor): Razorpay Dashboard → Webhooks → regenerate secret for the LocalMeals
     endpoint, paste into SM, redeploy api. Verify a payment.captured delivery (HMAC).
EOF
      ;;
    WHATSAPP_ACCESS_TOKEN)
      cat <<EOF
  → Follow-up (vendor): Meta Developer → WhatsApp → API Setup — issue a new permanent token,
     store in SM, redeploy api/worker. Send a test template / smoke WA outbound.
EOF
      ;;
    WHATSAPP_APP_SECRET)
      cat <<EOF
  → Follow-up (vendor): Meta App → Settings → Basic → App Secret (reset if compromised),
     store in SM, redeploy api. Inbound webhook HMAC must match.
EOF
      ;;
    WHATSAPP_VERIFY_TOKEN)
      cat <<EOF
  → Follow-up (vendor): Meta webhook Verify Token must match this value. Update the callback
     configuration in Meta, redeploy api, re-verify the webhook (GET challenge).
EOF
      ;;
  esac
}

read_secret_value() {
  # Sets NEW_VALUE. Prefer --stdin; else prompt (no echo) for vendor secrets; else generate.
  local name="$1"
  local mode="$2" # generate | prompt
  NEW_VALUE=""
  if [[ "$FROM_STDIN" -eq 1 ]]; then
    NEW_VALUE="$(cat)"
    if [[ -z "$NEW_VALUE" ]]; then
      err "stdin empty for $name"
      exit 1
    fi
    return 0
  fi
  if [[ ! -t 0 ]] && [[ "$mode" == "prompt" ]]; then
    # Non-interactive without --stdin: refuse rather than hang.
    err "$name needs a vendor-issued value. Re-run with --stdin or in a TTY."
    exit 1
  fi
  if [[ "$mode" == "generate" ]]; then
    NEW_VALUE="$(generate_token)"
    return 0
  fi
  # prompt, no echo
  printf 'Enter new value for %s (input hidden): ' "$name" >&2
  stty -echo
  IFS= read -r NEW_VALUE
  stty echo
  printf '\n' >&2
  if [[ -z "$NEW_VALUE" ]]; then
    err "empty value for $name"
    exit 1
  fi
}

update_scheduler_headers() {
  local token="$1"
  local job updated=0
  for job in "${SCHEDULER_JOBS[@]}"; do
    if ! gcloud scheduler jobs describe "$job" --location="$REGION" --project="$PROJECT_ID" >/dev/null 2>&1; then
      log "  skip scheduler $job (not found)"
      continue
    fi
    # --update-headers merges; does not print header values in normal output.
    gcloud scheduler jobs update http "$job" \
      --location="$REGION" \
      --project="$PROJECT_ID" \
      --update-headers="X-Internal-Token=${token}" \
      --quiet >/dev/null
    log "  OK  scheduler $job — X-Internal-Token updated"
    updated=$((updated + 1))
  done
  if [[ "$updated" -eq 0 ]]; then
    log "  NOTE: no scheduler jobs updated — set X-Internal-Token manually after deploy"
  fi
}

rotate_database_url() {
  log "==> DATABASE_URL (Cloud SQL password + Secret Manager)"
  local new_pass encoded conn_name url
  new_pass="$(openssl rand -base64 32 | tr -d '/+=' | head -c 32)"
  if [[ ${#new_pass} -lt 24 ]]; then
    err "failed to generate DB password"
    exit 1
  fi

  log "  setting Cloud SQL user password on ${SQL_INSTANCE}/${SQL_USER} (value not shown)"
  # --password is passed to the API; gcloud does not echo it back.
  gcloud sql users set-password "$SQL_USER" \
    --instance="$SQL_INSTANCE" \
    --project="$PROJECT_ID" \
    --password="$new_pass" \
    --quiet >/dev/null

  conn_name="${PROJECT_ID}:${REGION}:${SQL_INSTANCE}"
  encoded="$(urlencode_password "$new_pass")"
  # Cloud Run Unix-socket form (matches infra/terraform/sql.tf).
  url="postgres://${SQL_USER}:${encoded}@/${SQL_DB}?host=/cloudsql/${conn_name}"
  add_secret_version "DATABASE_URL" "$url"
  unset new_pass encoded url
  follow_up DATABASE_URL
}

rotate_internal_job_token() {
  log "==> INTERNAL_JOB_TOKEN"
  local token
  if [[ "$FROM_STDIN" -eq 1 ]]; then
    read_secret_value INTERNAL_JOB_TOKEN generate
    token="$NEW_VALUE"
  else
    token="$(generate_token)"
  fi
  add_secret_version "INTERNAL_JOB_TOKEN" "$token"
  update_scheduler_headers "$token"
  unset token NEW_VALUE
  follow_up INTERNAL_JOB_TOKEN
}

rotate_generated() {
  local name="$1"
  log "==> $name"
  read_secret_value "$name" generate
  add_secret_version "$name" "$NEW_VALUE"
  unset NEW_VALUE
  follow_up "$name"
}

rotate_vendor() {
  local name="$1"
  log "==> $name (vendor-issued — obtain from dashboard first if regenerating there)"
  read_secret_value "$name" prompt
  add_secret_version "$name" "$NEW_VALUE"
  unset NEW_VALUE
  follow_up "$name"
}

rotate_one() {
  local name="$1"
  case "$name" in
    DATABASE_URL) rotate_database_url ;;
    INTERNAL_JOB_TOKEN) rotate_internal_job_token ;;
    AUTH_SECRET|WHATSAPP_VERIFY_TOKEN) rotate_generated "$name" ;;
    RAZORPAY_KEY_SECRET|RAZORPAY_WEBHOOK_SECRET|WHATSAPP_ACCESS_TOKEN|WHATSAPP_APP_SECRET)
      rotate_vendor "$name"
      ;;
    *)
      err "Unknown secret: $name (allowed: ${ALL_SECRETS[*]})"
      exit 1
      ;;
  esac
}

# --- args ---
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h|--help) usage; exit 0 ;;
    --list) LIST_ONLY=1; shift ;;
    --stdin) FROM_STDIN=1; shift ;;
    --all) TARGETS=("${ALL_SECRETS[@]}"); shift ;;
    -*)
      err "Unknown flag: $1"
      usage
      exit 1
      ;;
    *)
      TARGETS+=("$1")
      shift
      ;;
  esac
done

if [[ "$LIST_ONLY" -eq 1 ]]; then
  printf '%s\n' "${ALL_SECRETS[@]}"
  exit 0
fi

if [[ ${#TARGETS[@]} -eq 0 ]]; then
  TARGETS=("${ALL_SECRETS[@]}")
fi

if [[ "$FROM_STDIN" -eq 1 && ${#TARGETS[@]} -ne 1 ]]; then
  err "--stdin requires exactly one SECRET argument"
  exit 1
fi

require_gcloud
log "Project ${PROJECT_ID} · region ${REGION} · prefix ${PREFIX}"
log "Rotating ${#TARGETS[@]} secret(s). Values are never printed."
log ""

for s in "${TARGETS[@]}"; do
  rotate_one "$s"
  log ""
done

cat <<EOF
Done. Recommended order from here (see docs/RUNBOOK.md §11):
  1. Finish any vendor dashboard steps printed above
  2. Redeploy api + worker (pick up Secret Manager :latest)
  3. Verify: health/ready, Razorpay webhook, WA verify, Scheduler dry-run
  4. Disable old Secret Manager versions after soak
  5. Purge tfplan from git history (documented in RUNBOOK — do not force-push casually)
EOF
