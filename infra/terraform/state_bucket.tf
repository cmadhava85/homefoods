# Optional remote state bucket (create once, then enable backend in versions.tf).

resource "google_storage_bucket" "tfstate" {
  count = var.create_tf_state_bucket ? 1 : 0

  name                        = var.tf_state_bucket_name
  location                    = var.region
  uniform_bucket_level_access = true
  versioning {
    enabled = true
  }
  force_destroy = false

  depends_on = [google_project_service.apis]
}
