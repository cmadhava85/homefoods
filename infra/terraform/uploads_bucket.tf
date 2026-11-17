# Shared object storage for menu / concern photos (Cloud Run is multi-instance).

resource "google_storage_bucket" "uploads" {
  name                        = "${var.project_id}-${var.name_prefix}-uploads"
  location                    = var.region
  project                     = var.project_id
  uniform_bucket_level_access = true
  force_destroy               = false

  versioning {
    enabled = false
  }

  # Private bucket — API proxies GET /uploads/* with the Run SA.
  public_access_prevention = "enforced"

  labels = {
    app = var.name_prefix
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "uploads_run_object_admin" {
  bucket = google_storage_bucket.uploads.name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run.email}"
}
