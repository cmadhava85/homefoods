# Public static status / support page (survives Cloud Run outages).
# Upload infra/status/index.html after apply, e.g.:
#   gsutil cp infra/status/index.html "gs://${project_id}-${name_prefix}-status/index.html"
# URL: https://storage.googleapis.com/<bucket>/index.html
# Or attach a custom domain via load balancer / CDN later.
#
# Off by default — set enable_status_page = true in tfvars when ready (no apply from this prompt).

variable "enable_status_page" {
  type        = bool
  description = "Create a public GCS bucket for infra/status/index.html"
  default     = false
}

resource "google_storage_bucket" "status" {
  count = var.enable_status_page ? 1 : 0

  name                        = "${var.project_id}-${var.name_prefix}-status"
  location                    = var.region
  project                     = var.project_id
  uniform_bucket_level_access = true
  public_access_prevention    = "inherited"
  force_destroy               = false

  website {
    main_page_suffix = "index.html"
    not_found_page   = "index.html"
  }

  labels = {
    app  = var.name_prefix
    cost = "solo-lean"
    role = "status"
  }

  depends_on = [google_project_service.apis]
}

resource "google_storage_bucket_iam_member" "status_public_read" {
  count  = var.enable_status_page ? 1 : 0
  bucket = google_storage_bucket.status[0].name
  role   = "roles/storage.objectViewer"
  member = "allUsers"
}

output "status_page_url" {
  description = "Public status page URL (empty when enable_status_page=false)"
  value = var.enable_status_page ? (
    "https://storage.googleapis.com/${google_storage_bucket.status[0].name}/index.html"
  ) : ""
}
