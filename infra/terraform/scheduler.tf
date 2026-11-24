# Meal cut-offs + EOD settlement — needs a resolvable API base URL + INTERNAL_JOB_TOKEN.
# Cloud Run may be deployed by CI (create_cloud_run=false); set api_url or web_public_api_url.

locals {
  api_base_url = (
    var.api_custom_domain != ""
    ? "https://${var.api_custom_domain}"
    : (
      var.api_url != ""
      ? trimsuffix(var.api_url, "/")
      : (
        var.web_public_api_url != ""
        ? trimsuffix(var.web_public_api_url, "/")
        : (local.create_api ? google_cloud_run_v2_service.api[0].uri : "")
      )
    )
  )
  create_scheduler = var.create_scheduler && local.api_base_url != ""
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
      "X-Job-Caller"     = "scheduler"
    }
  }

  retry_config {
    retry_count = 2
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "breakfast_cutoff" {
  count = local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-breakfast-cutoff"
  description      = "POST /internal/cutoffs/BREAKFAST (Asia/Kolkata)"
  schedule         = var.lunch_cutoff_schedule
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "320s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "${local.api_base_url}/internal/cutoffs/BREAKFAST"
    body        = base64encode(jsonencode({ force = false }))

    headers = {
      "Content-Type"     = "application/json"
      "X-Internal-Token" = random_password.internal_job_token.result
      "X-Job-Caller"     = "scheduler"
    }
  }

  retry_config {
    retry_count = 2
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "dinner_cutoff" {
  count = local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-dinner-cutoff"
  description      = "POST /internal/cutoffs/DINNER (Asia/Kolkata)"
  schedule         = var.lunch_cutoff_schedule
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "320s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "${local.api_base_url}/internal/cutoffs/DINNER"
    body        = base64encode(jsonencode({ force = false }))

    headers = {
      "Content-Type"     = "application/json"
      "X-Internal-Token" = random_password.internal_job_token.result
      "X-Job-Caller"     = "scheduler"
    }
  }

  retry_config {
    retry_count = 2
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "eod_settlement" {
  count = local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-eod"
  description      = "POST /internal/settlements/eod at 21:00 IST (after dinner)"
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
      "X-Job-Caller"     = "scheduler"
    }
  }

  retry_config {
    retry_count = 2
  }

  depends_on = [google_project_service.apis]
}

resource "google_cloud_scheduler_job" "expire_unpaid" {
  count = local.create_scheduler ? 1 : 0

  name             = "${var.name_prefix}-expire-unpaid"
  description      = "POST /internal/ops/expire-unpaid every 5m (stale UPI holds)"
  schedule         = "*/5 * * * *"
  time_zone        = "Asia/Kolkata"
  attempt_deadline = "120s"
  region           = var.region

  http_target {
    http_method = "POST"
    uri         = "${local.api_base_url}/internal/ops/expire-unpaid"
    body        = base64encode("{}")

    headers = {
      "Content-Type"     = "application/json"
      "X-Internal-Token" = random_password.internal_job_token.result
      "X-Job-Caller"     = "scheduler"
    }
  }

  retry_config {
    retry_count = 1
  }

  depends_on = [google_project_service.apis]
}
