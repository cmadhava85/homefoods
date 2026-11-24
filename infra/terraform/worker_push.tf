# Scale-to-zero worker (worker_push_mode=true):
#   API enqueues outbox rows → publishes to the wake topic after the response → push subscription
#   POSTs <worker>/drain with an OIDC token → worker drains until empty → instance idles to zero.
#   A 1-minute Cloud Scheduler call to /drain is the safety net (lost wakes, retries, retention job).
# Pub/Sub push and Cloud Scheduler count as internal traffic, so the worker keeps internal-only ingress.

locals {
  worker_push       = var.worker_push_mode && local.create_worker
  outbox_wake_topic = local.worker_push ? google_pubsub_topic.outbox_wake[0].id : ""
}

resource "google_pubsub_topic" "outbox_wake" {
  count = local.worker_push ? 1 : 0
  name  = "${var.name_prefix}.outbox-wake"
  # A wake is only useful for a few minutes; the scheduler covers anything older.
  message_retention_duration = "600s"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic_iam_member" "api_publishes_wake" {
  count  = local.worker_push ? 1 : 0
  topic  = google_pubsub_topic.outbox_wake[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:${google_service_account.run.email}"
}

resource "google_cloud_run_v2_service_iam_member" "worker_invoker" {
  count    = local.worker_push ? 1 : 0
  name     = google_cloud_run_v2_service.worker[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "serviceAccount:${google_service_account.run.email}"
}

# Lets Pub/Sub mint the OIDC token for push requests (automatic on newer projects; explicit here).
resource "google_service_account_iam_member" "pubsub_token_creator" {
  count              = local.worker_push ? 1 : 0
  service_account_id = google_service_account.run.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}

resource "google_pubsub_subscription" "outbox_wake_push" {
  count = local.worker_push ? 1 : 0
  name  = "${var.name_prefix}-worker-outbox-wake"
  topic = google_pubsub_topic.outbox_wake[0].id

  # Worker drains for up to 45 s per wake.
  ack_deadline_seconds       = 60
  message_retention_duration = "600s"

  push_config {
    push_endpoint = "${google_cloud_run_v2_service.worker[0].uri}/drain"
    oidc_token {
      service_account_email = google_service_account.run.email
      audience              = google_cloud_run_v2_service.worker[0].uri
    }
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "60s"
  }

  expiration_policy {
    ttl = ""
  }

  depends_on = [google_service_account_iam_member.pubsub_token_creator]
}

resource "google_cloud_scheduler_job" "worker_drain" {
  count = local.worker_push && local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-worker-drain"
  description      = "Fallback POST <worker>/drain every minute (scale-to-zero worker)"
  schedule         = "* * * * *"
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "60s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "${google_cloud_run_v2_service.worker[0].uri}/drain"
    oidc_token {
      service_account_email = google_service_account.run.email
      audience              = google_cloud_run_v2_service.worker[0].uri
    }
  }

  retry_config {
    retry_count = 0
  }

  depends_on = [google_cloud_run_v2_service_iam_member.worker_invoker]
}
