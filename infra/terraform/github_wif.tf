# Optional Workload Identity Federation for GitHub Actions → Cloud Run deploy.
# Enable: create_github_wif = true , github_repository = "OWNER/REPO"

locals {
  enable_github_wif = var.create_github_wif && var.github_repository != ""
}

resource "google_service_account" "github_deploy" {
  count = local.enable_github_wif ? 1 : 0

  account_id   = "${var.name_prefix}-github-deploy"
  display_name = "GitHub Actions Cloud Run deploy"
  project      = var.project_id
}

resource "google_iam_workload_identity_pool" "github" {
  count = local.enable_github_wif ? 1 : 0

  workload_identity_pool_id = "${var.name_prefix}-github"
  display_name              = "GitHub Actions"
  project                   = var.project_id
}

resource "google_iam_workload_identity_pool_provider" "github" {
  count = local.enable_github_wif ? 1 : 0

  project                            = var.project_id
  workload_identity_pool_id          = google_iam_workload_identity_pool.github[0].workload_identity_pool_id
  workload_identity_pool_provider_id = "github"
  display_name                       = "GitHub"

  attribute_mapping = {
    "google.subject"       = "assertion.sub"
    "attribute.actor"      = "assertion.actor"
    "attribute.repository" = "assertion.repository"
    "attribute.ref"        = "assertion.ref"
  }

  # Repo + main only — blocks PR/feature-branch workflows from impersonating deploy SA.
  attribute_condition = "assertion.repository == \"${var.github_repository}\" && assertion.ref == \"refs/heads/main\""

  oidc {
    issuer_uri = "https://token.actions.githubusercontent.com"
  }
}

resource "google_service_account_iam_member" "github_wif_user" {
  count = local.enable_github_wif ? 1 : 0

  service_account_id = google_service_account.github_deploy[0].name
  role               = "roles/iam.workloadIdentityUser"
  member             = "principalSet://iam.googleapis.com/${google_iam_workload_identity_pool.github[0].name}/attribute.repository/${var.github_repository}"
}

resource "google_service_account_iam_member" "github_act_as_run" {
  count = local.enable_github_wif ? 1 : 0

  service_account_id = google_service_account.run.name
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.github_deploy[0].email}"
}

locals {
  github_deploy_roles = local.enable_github_wif ? toset([
    "roles/run.admin",
    "roles/artifactregistry.writer",
    "roles/iam.serviceAccountUser",
    "roles/secretmanager.secretAccessor",
  ]) : toset([])
}

resource "google_project_iam_member" "github_deploy" {
  for_each = local.github_deploy_roles

  project = var.project_id
  role    = each.value
  member  = "serviceAccount:${google_service_account.github_deploy[0].email}"
}
