#!/usr/bin/env bash
# Sleep staging / idle solo GCP spend: worker → 0, Cloud SQL stopped.
# Wake with: scripts/cost-wake-staging.sh
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-home-food-513806}"
REGION="${GCP_REGION:-asia-south1}"
PREFIX="${NAME_PREFIX:-localmeals}"

echo "==> Project $PROJECT_ID · region $REGION"

gcloud config set project "$PROJECT_ID" >/dev/null

if gcloud run services describe "${PREFIX}-worker" --region="$REGION" --format='value(name)' >/dev/null 2>&1; then
  echo "==> Cloud Run worker min-instances → 0"
  gcloud run services update "${PREFIX}-worker" \
    --region="$REGION" \
    --min-instances=0 \
    --quiet
else
  echo "==> No ${PREFIX}-worker service (skip)"
fi

SQL="${PREFIX}-pg"
if gcloud sql instances describe "$SQL" --format='value(name)' >/dev/null 2>&1; then
  echo "==> Cloud SQL $SQL activation-policy → NEVER (stops compute billing)"
  gcloud sql instances patch "$SQL" --activation-policy=NEVER --quiet
else
  echo "==> No SQL instance $SQL (skip)"
fi

echo "Done. API/web already scale to zero when idle."
echo "Wake later: ./scripts/cost-wake-staging.sh"
