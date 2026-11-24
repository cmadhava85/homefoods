# Long-term Cloud Run log archive (Cloud Logging _Default is ~30d).
# Enable with log_archive_enabled=true. Objects age out after 180 days.

resource "google_storage_bucket" "log_archive" {
  count = var.log_archive_enabled ? 1 : 0

  name                        = "${var.project_id}-${var.name_prefix}-logs"
  location                    = var.region
  project                     = var.project_id
  uniform_bucket_level_access = true
  force_destroy               = false
  public_access_prevention    = "enforced"

  lifecycle_rule {
    action {
      type = "Delete"
    }
    condition {
      age = 180
    }
  }

  labels = {
    app  = var.name_prefix
    purpose = "log-archive"
  }

  depends_on = [google_project_service.apis]
}

resource "google_logging_project_sink" "cloud_run_archive" {
  count = var.log_archive_enabled ? 1 : 0

  name        = "${var.name_prefix}-cloud-run-logs"
  destination = "storage.googleapis.com/${google_storage_bucket.log_archive[0].name}"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    resource.labels.service_name=~"${var.name_prefix}-"
  EOT

  unique_writer_identity = true
}

resource "google_storage_bucket_iam_member" "log_archive_writer" {
  count = var.log_archive_enabled ? 1 : 0

  bucket = google_storage_bucket.log_archive[0].name
  role   = "roles/storage.objectCreator"
  member = google_logging_project_sink.cloud_run_archive[0].writer_identity
}
