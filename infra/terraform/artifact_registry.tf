resource "google_artifact_registry_repository" "localmeals" {
  location      = var.region
  repository_id = var.name_prefix
  description   = "LocalMeals container images"
  format        = "DOCKER"

  depends_on = [google_project_service.apis]
}
