output "project_id" {
  value = var.project_id
}

output "region" {
  value = var.region
}

output "artifact_registry" {
  value = "${var.region}-docker.pkg.dev/${var.project_id}/${google_artifact_registry_repository.localmeals.repository_id}"
}

output "vpc_connector" {
  value = google_vpc_access_connector.connector.id
}

output "sql_connection_name" {
  value = google_sql_database_instance.postgres.connection_name
}

output "sql_instance_name" {
  value = google_sql_database_instance.postgres.name
}

output "pubsub_topics" {
  value = [for t in google_pubsub_topic.events : t.name]
}

output "secret_ids" {
  value = [for s in google_secret_manager_secret.app : s.secret_id]
}

output "database_url_secret" {
  value       = "projects/${var.project_id}/secrets/DATABASE_URL"
  description = "Cloud Run should mount this secret as DATABASE_URL"
}

output "run_service_account" {
  value = google_service_account.run.email
}

output "api_url" {
  value       = local.create_api ? google_cloud_run_v2_service.api[0].uri : null
  description = "Cloud Run API URL (null until create_cloud_run + api_image)"
}

output "web_url" {
  value       = local.create_web ? google_cloud_run_v2_service.web[0].uri : null
  description = "Cloud Run web URL"
}

output "worker_url" {
  value       = local.create_worker ? google_cloud_run_v2_service.worker[0].uri : null
  description = "Cloud Run worker URL (internal)"
}

output "scheduler_jobs" {
  value = local.create_scheduler ? [
    google_cloud_scheduler_job.lunch_cutoff[0].name,
    google_cloud_scheduler_job.eod_settlement[0].name,
  ] : []
}

output "tf_state_bucket" {
  value = var.create_tf_state_bucket ? google_storage_bucket.tfstate[0].name : null
}

output "uploads_bucket" {
  value       = google_storage_bucket.uploads.name
  description = "GCS bucket for menu/concern photos (set as GCS_UPLOADS_BUCKET on API)"
}

output "github_actions_secrets" {
  description = "Values to paste into GitHub Actions secrets (when create_github_wif=true)"
  value = local.enable_github_wif ? {
    GCP_PROJECT_ID                 = var.project_id
    GCP_REGION                     = var.region
    GCP_SERVICE_ACCOUNT            = google_service_account.github_deploy[0].email
    GCP_WORKLOAD_IDENTITY_PROVIDER = google_iam_workload_identity_pool_provider.github[0].name
  } : null
}

output "next_steps" {
  value = <<-EOT
    1) terraform apply (or import existing — see README)
    2) Migrations via Cloud SQL Auth Proxy:
         cloud-sql-proxy ${google_sql_database_instance.postgres.connection_name}
         DATABASE_URL=postgres://localmeals:PASSWORD@127.0.0.1:5432/localmeals npm run db:migrate
    3) Build/push images to ${var.region}-docker.pkg.dev/${var.project_id}/${var.name_prefix}
    4) Set create_cloud_run=true + api_image / worker_image / web_image (scheduler follows when create_scheduler=true)
    5) Ensure WhatsApp/Razorpay secret versions are real (not REPLACE_ME)
    6) Optional: alert_email=you@… ; api_custom_domain / web_custom_domain
    7) Optional remote state: create_tf_state_bucket=true, then uncomment backend in versions.tf
  EOT
}
