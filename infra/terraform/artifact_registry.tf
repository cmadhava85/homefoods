resource "google_artifact_registry_repository" "localmeals" {
  location      = var.region
  repository_id = var.name_prefix
  description   = "LocalMeals container images"
  format        = "DOCKER"

  # Solo launch: prune old tags so Artifact Registry storage stays small.
  cleanup_policy_dry_run = false

  cleanup_policies {
    id     = "keep-minimum-versions"
    action = "KEEP"
    most_recent_versions {
      keep_count = var.artifact_keep_versions
    }
  }

  cleanup_policies {
    id     = "delete-older-than-30d"
    action = "DELETE"
    condition {
      tag_state  = "ANY"
      older_than = "2592000s" # 30 days
    }
  }

  depends_on = [google_project_service.apis]
}
