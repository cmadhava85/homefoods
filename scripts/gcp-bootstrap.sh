#!/usr/bin/env bash
# LocalMeals GCP bootstrap — run in Terminal.app (not Cursor agent sandbox)
# Project: home-food-513806
set -euo pipefail

PROJECT_ID="${GCP_PROJECT_ID:-home-food-513806}"
REGION="${GCP_REGION:-asia-south1}"

export PATH="/opt/homebrew/bin:$PATH"

echo "==> 1) Login (Chrome will open)"
# Force Chrome as the browser helper on macOS
export BROWSER='open -a Google Chrome'
gcloud auth login
gcloud auth application-default login

echo "==> 2) Set project ${PROJECT_ID}"
gcloud config set project "${PROJECT_ID}"
gcloud config set compute/region "${REGION}"

echo "==> 3) Verify access"
gcloud projects describe "${PROJECT_ID}" --format='value(projectId,name,lifecycleState)'
gcloud auth list

echo "==> 4) Enable APIs (MVP-1)"
gcloud services enable \
  run.googleapis.com \
  sqladmin.googleapis.com \
  secretmanager.googleapis.com \
  artifactregistry.googleapis.com \
  cloudscheduler.googleapis.com \
  vpcaccess.googleapis.com \
  compute.googleapis.com \
  logging.googleapis.com \
  monitoring.googleapis.com \
  --project="${PROJECT_ID}"

echo "==> Done. Next: create Artifact Registry + Cloud SQL (see docs/INFRASTRUCTURE.md §2)."
echo "    PROJECT_ID=${PROJECT_ID}  REGION=${REGION}"
