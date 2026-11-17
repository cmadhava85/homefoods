# Runtime identity for Cloud Run api + worker (SQL + secrets).

resource "google_service_account" "run" {
  account_id   = "${var.name_prefix}-run"
  display_name = "LocalMeals Cloud Run"
  project      = var.project_id
}

resource "google_project_iam_member" "run_cloudsql" {
  project = var.project_id
  role    = "roles/cloudsql.client"
  member  = "serviceAccount:${google_service_account.run.email}"
}

resource "google_secret_manager_secret_iam_member" "run_secret_accessor" {
  for_each = google_secret_manager_secret.app

  project   = var.project_id
  secret_id = each.value.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${google_service_account.run.email}"
}

resource "google_pubsub_subscription_iam_member" "run_subscriber" {
  for_each = google_pubsub_subscription.worker

  subscription = each.value.name
  role         = "roles/pubsub.subscriber"
  member       = "serviceAccount:${google_service_account.run.email}"
}
