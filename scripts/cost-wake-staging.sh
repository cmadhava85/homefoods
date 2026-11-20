#!/usr/bin/env bash
# Wake staging after cost-sleep-staging.sh
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-home-food-513806}"
REGION="${GCP_REGION:-asia-south1}"
PREFIX="${NAME_PREFIX:-localmeals}"
WORKER_MIN="${WORKER_MIN_INSTANCES:-1}"

echo "==> Project $PROJECT_ID · region $REGION"

gcloud config set project "$PROJECT_ID" >/dev/null

SQL="${PREFIX}-pg"
if gcloud sql instances describe "$SQL" --format='value(name)' >/dev/null 2>&1; then
  echo "==> Cloud SQL $SQL activation-policy → ALWAYS"
  gcloud sql instances patch "$SQL" --activation-policy=ALWAYS --quiet
  echo "    Waiting for RUNNABLE…"
  for _ in $(seq 1 60); do
    state=$(gcloud sql instances describe "$SQL" --format='value(state)' 2>/dev/null || echo "")
    if [[ "$state" == "RUNNABLE" ]]; then
      echo "    SQL is RUNNABLE"
      break
    fi
    sleep 5
  done
else
  echo "==> No SQL instance $SQL (skip)"
fi

if gcloud run services describe "${PREFIX}-worker" --region="$REGION" --format='value(name)' >/dev/null 2>&1; then
  echo "==> Cloud Run worker min-instances → $WORKER_MIN"
  gcloud run services update "${PREFIX}-worker" \
    --region="$REGION" \
    --min-instances="$WORKER_MIN" \
    --quiet
else
  echo "==> No ${PREFIX}-worker service (skip)"
fi

echo "Done. Smoke: curl -sS \"\$(gcloud run services describe ${PREFIX}-api --region=$REGION --format='value(status.url)')/health\""
