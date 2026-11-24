# Cost: excluded entries are dropped before ingestion (not billed, not stored).
# Alerts are unaffected — api_5xx uses the run.googleapis.com/request_count metric, and the
# log-based metrics key on jsonPayload.event values that are never excluded here.

resource "google_logging_project_exclusion" "cloud_run_request_ok" {
  count = var.log_exclusions_enabled ? 1 : 0

  name        = "${var.name_prefix}-run-requests-ok"
  description = "Cloud Run platform request logs for non-error responses (the app logs its own request.completed)"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    logName="projects/${var.project_id}/logs/run.googleapis.com%2Frequests"
    httpRequest.status<400
  EOT
}
