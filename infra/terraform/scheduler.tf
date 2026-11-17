# Lunch cut-off + EOD settlement — requires public API + INTERNAL_JOB_TOKEN.

locals {
  create_scheduler = var.create_scheduler && local.create_api
  api_base_url = (
    var.api_custom_domain != ""
    ? "https://${var.api_custom_domain}"
    : (local.create_api ? google_cloud_run_v2_service.api[0].uri : "")
  )
}

resource "google_cloud_scheduler_job" "lunch_cutoff" {
  count = local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-lunch-cutoff"
  description      = "POST /internal/cutoffs/LUNCH (Asia/Kolkata)"
  schedule         = var.lunch_cutoff_schedule
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "320s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "${local.api_base_url}/internal/cutoffs/LUNCH"
    body        = base64encode(jsonencode({ force = false }))

    headers = {
      "Content-Type"     = "application/json"
      "X-Internal-Token" = random_password.internal_job_token.result
    }
  }

  retry_config {
    retry_count = 2
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_service.api,
  ]
}

resource "google_cloud_scheduler_job" "eod_settlement" {
  count = local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-eod"
  description      = "POST /internal/settlements/eod at 18:00 IST"
  schedule         = var.eod_schedule
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "320s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "${local.api_base_url}/internal/settlements/eod"
    body        = base64encode("{}")

    headers = {
      "Content-Type"     = "application/json"
      "X-Internal-Token" = random_password.internal_job_token.result
    }
  }

  retry_config {
    retry_count = 2
  }

  depends_on = [
    google_project_service.apis,
    google_cloud_run_v2_service.api,
  ]
}
