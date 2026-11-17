#!/usr/bin/env bash
# Import resources created manually (gcloud) into Terraform state.
# Run from infra/terraform after: terraform init
set -euo pipefail

PROJECT_ID="${TF_VAR_project_id:-home-food-513806}"
REGION="${TF_VAR_region:-asia-south1}"
PREFIX="${TF_VAR_name_prefix:-localmeals}"

echo "Importing into project=${PROJECT_ID} region=${REGION}"

terraform import 'google_artifact_registry_repository.localmeals' \
  "projects/${PROJECT_ID}/locations/${REGION}/repositories/${PREFIX}" || true

terraform import 'google_vpc_access_connector.connector' \
  "projects/${PROJECT_ID}/locations/${REGION}/connectors/${PREFIX}-conn" || true

terraform import 'google_sql_database_instance.postgres' \
  "projects/${PROJECT_ID}/instances/${PREFIX}-pg" || true

terraform import 'google_sql_database.localmeals' \
  "projects/${PROJECT_ID}/instances/${PREFIX}-pg/databases/localmeals" || true

terraform import 'google_sql_user.localmeals' \
  "${PROJECT_ID}/${PREFIX}-pg/localmeals" || true

EVENTS=(order-created order-paid order-cancelled order-refunded cutoff-reached settlement-batch-completed)
for e in "${EVENTS[@]}"; do
  terraform import "google_pubsub_topic.events[\"${e}\"]" "projects/${PROJECT_ID}/topics/${PREFIX}.${e}" || true
  terraform import "google_pubsub_subscription.worker[\"${e}\"]" "projects/${PROJECT_ID}/subscriptions/${PREFIX}-worker-${e}" || true
done

terraform import 'google_pubsub_topic.dead_letter' \
  "projects/${PROJECT_ID}/topics/${PREFIX}.dead-letter" || true

APIS=(
  run.googleapis.com
  sqladmin.googleapis.com
  secretmanager.googleapis.com
  artifactregistry.googleapis.com
  cloudscheduler.googleapis.com
  vpcaccess.googleapis.com
  compute.googleapis.com
  logging.googleapis.com
  monitoring.googleapis.com
  pubsub.googleapis.com
  iam.googleapis.com
  servicenetworking.googleapis.com
)
for a in "${APIS[@]}"; do
  terraform import "google_project_service.apis[\"${a}\"]" "${PROJECT_ID}/${a}" || true
done

echo "Import attempts finished. Run: terraform plan"
echo "NOTE: SQL user password will be rotated on next apply (random_password) and DATABASE_URL secret updated."
