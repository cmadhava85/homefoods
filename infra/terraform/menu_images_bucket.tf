# Public-read bucket for MENU photos only — served straight from GCS's edge cache instead of streaming
# through the API (no API CPU/egress per image). Concern photos stay in the private uploads bucket.

resource "google_storage_bucket" "menu_public" {
  count = var.menu_images_public ? 1 : 0

  name                        = "${var.project_id}-${var.name_prefix}-menu-public"
  location                    = var.region
  project                     = var.project_id
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
  force_destroy               = false

  labels = {
    app  = var.name_prefix
    cost = "solo-lean"
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "menu_public_read" {
  count  = var.menu_images_public ? 1 : 0
  bucket = google_storage_bucket.menu_public[0].name
  role   = "roles/storage.objectViewer"
  # Intentional public CDN for menu photos only (no PII). Concern uploads stay private.
  #trivy:ignore:AVD-GCP-0001
  #trivy:ignore:GCP-0001
  member = "allUsers"
}

resource "google_storage_bucket_iam_member" "menu_public_run_writer" {
  count  = var.menu_images_public ? 1 : 0
  bucket = google_storage_bucket.menu_public[0].name
  role   = "roles/storage.objectAdmin"
  member = "serviceAccount:${google_service_account.run.email}"
}

output "menu_images_public_base" {
  description = "Set as NEXT_PUBLIC_MENU_IMAGES_BASE (web build) — empty when disabled"
  value       = var.menu_images_public ? "https://storage.googleapis.com/${google_storage_bucket.menu_public[0].name}" : ""
}
