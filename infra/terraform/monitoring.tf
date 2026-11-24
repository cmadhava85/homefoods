# MVP-1 production observability: Cloud Monitoring alerts + log-based metrics.
# Set alert_email to create the notification channel and policies.
# Cloud Run may be CI-managed (create_cloud_run=false); use api_service_name / api_url / web_url.

resource "google_monitoring_notification_channel" "email" {
  count = var.alert_email != "" ? 1 : 0

  display_name = "LocalMeals ops"
  type         = "email"
  labels = {
    email_address = var.alert_email
  }
}

locals {
  has_alerts = var.alert_email != ""
  # Cloud Run services emit jsonPayload.event from Pino (messageKey=message, severity).
  log_metric_prefix = var.name_prefix
  alert_channels = local.has_alerts ? concat(
    [google_monitoring_notification_channel.email[0].id],
    var.alert_channels_extra
  ) : []
  runbook_base = "https://github.com/localmeals/localmeals/blob/main/docs/RUNBOOK.md"
}

# --- Log-based metrics (stable `event` field from @localmeals/observability) ---

resource "google_logging_metric" "webhook_signature_failed" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-webhook-signature-failed"
  description = "Razorpay/WhatsApp webhook HMAC rejections"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="webhook.signature_failed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "outbox_failed" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-outbox-failed"
  description = "Worker outbox handler failures"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="outbox.failed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "wa_send_failed" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-whatsapp-send-failed"
  description = "WhatsApp outbound send failures"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="whatsapp.send_failed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "payment_confirming_stuck" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-payment-confirming-stuck"
  description = "Orders stuck in CONFIRMING_PAYMENT (worker scan)"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="payment.confirming_stuck"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "ticket_sla_breached" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-ticket-sla-breached"
  description = "Support tickets past slaDueAt (worker scan, once per ticket)"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="ticket.sla_breached"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "settlement_batch_failed" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-settlement-batch-failed"
  description = "EOD settlement transfer / payout account failures"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="settlement.batch_failed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "settlement_batch_completed" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-settlement-batch-completed"
  description = "EOD settlement batch completed (success path)"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="settlement.batch_completed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

resource "google_logging_metric" "cutoff_reached" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-cutoff-reached"
  description = "Lunch/meal cutoff locks emitted"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="cutoff.reached"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# P2-13: worker emits retention.completed after daily purge.
# TODO alert: absence of this metric for > 26h (once alert_email policies are live).
resource "google_logging_metric" "retention_completed" {
  count = local.has_alerts ? 1 : 0

  name        = "${local.log_metric_prefix}-retention-completed"
  description = "Daily PII retention job completed (alert if absent > 26h)"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="retention.completed"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "INT64"
    unit        = "1"
  }
}

# Stub until worker emits outbox.backlog with oldestPendingAgeSec (OPS_READINESS P1-7).
resource "google_logging_metric" "outbox_oldest_pending_age_sec" {
  count = local.has_alerts ? 1 : 0

  name        = "outbox_oldest_pending_age_sec"
  description = "Oldest pending outbox row age in seconds (from outbox.backlog logs)"
  filter      = <<-EOT
    resource.type="cloud_run_revision"
    jsonPayload.event="outbox.backlog"
  EOT
  metric_descriptor {
    metric_kind = "DELTA"
    value_type  = "DISTRIBUTION"
    unit        = "s"
  }
  value_extractor = "EXTRACT(jsonPayload.oldestPendingAgeSec)"
  bucket_options {
    exponential_buckets {
      num_finite_buckets = 64
      growth_factor      = 2
      scale              = 1
    }
  }
}

# --- Alert policies ---

resource "google_monitoring_alert_policy" "api_5xx" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals API 5xx"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run api 5xx count"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.api_service_name}\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 5
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "API returning 5xx. See [RUNBOOK §6.I High 5xx / rate-limit / DB](${local.runbook_base}#i-high-5xx--rate-limit--db) and [§6.A Nobody can order](${local.runbook_base}#a-nobody-can-order)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "api_latency_p95" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals API p95 latency > 2s"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run api request latency p95"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.api_service_name}\" AND metric.type = \"run.googleapis.com/request_latencies\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 2000
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_95"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "API p95 latency above 2s for 10m. See [RUNBOOK §6.I High 5xx / rate-limit / DB](${local.runbook_base}#i-high-5xx--rate-limit--db)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "scheduler_failures" {
  count = local.has_alerts && local.create_scheduler ? 1 : 0

  display_name = "LocalMeals Scheduler job failures"
  combiner     = "OR"

  conditions {
    display_name = "Scheduler attempt not OK"
    condition_threshold {
      filter          = "resource.type = \"cloud_scheduler_job\" AND metric.type = \"cloudscheduler.googleapis.com/job/attempt_count\" AND metric.labels.status != \"OK\" AND resource.labels.job_id = monitoring.regex.full_match(\"${var.name_prefix}-(lunch-cutoff|eod)\")"
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_SUM"
        cross_series_reducer = "REDUCE_SUM"
        group_by_fields      = ["resource.label.job_id"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Scheduler lunch-cutoff or EOD attempt failed. See [RUNBOOK §3 Scheduled jobs](${local.runbook_base}#3-scheduled-jobs) and [§6.D Cut-off or EOD missed](${local.runbook_base}#d-cut-off-or-eod-missed)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "webhook_signature_failed" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals webhook signature failures"
  combiner     = "OR"

  conditions {
    display_name = "webhook.signature_failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-webhook-signature-failed\""
      duration        = "60s"
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Webhook HMAC rejections. See [RUNBOOK §7 Webhooks](${local.runbook_base}#7-webhooks-must-stay-green) and [§6.B Payments stuck](${local.runbook_base}#b-payments-stuck--not-paid)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.webhook_signature_failed, google_project_service.apis]
}

resource "google_monitoring_alert_policy" "outbox_failed" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals outbox failures"
  combiner     = "OR"

  conditions {
    display_name = "outbox.failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-outbox-failed\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 2
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Worker outbox handler failures. See [RUNBOOK §6.C WhatsApp silent](${local.runbook_base}#c-whatsapp-silent--inbound-broken) and Admin order outbox."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.outbox_failed, google_project_service.apis]
}

resource "google_monitoring_alert_policy" "outbox_oldest_pending" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals outbox oldest pending age"
  combiner     = "OR"

  conditions {
    display_name = "outbox_oldest_pending_age_sec > 300s"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/outbox_oldest_pending_age_sec\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 300
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_PERCENTILE_99"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Oldest pending outbox row age > 300s for 5m (metric `outbox_oldest_pending_age_sec` from `outbox.backlog`; stub until P1-7 emits the field). See [RUNBOOK §6.C WhatsApp silent](${local.runbook_base}#c-whatsapp-silent--inbound-broken)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.outbox_oldest_pending_age_sec, google_project_service.apis]
}

resource "google_monitoring_alert_policy" "wa_send_failed" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals WhatsApp send failures"
  combiner     = "OR"

  conditions {
    display_name = "whatsapp.send_failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-whatsapp-send-failed\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = 3
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "WhatsApp outbound send failures. See [RUNBOOK §6.C WhatsApp silent](${local.runbook_base}#c-whatsapp-silent--inbound-broken)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.wa_send_failed, google_project_service.apis]
}

resource "google_monitoring_alert_policy" "payment_confirming_stuck" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals CONFIRMING_PAYMENT stuck"
  combiner     = "OR"

  conditions {
    display_name = "payment.confirming_stuck"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-payment-confirming-stuck\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Order stuck in CONFIRMING_PAYMENT. See [RUNBOOK §6.B Payments stuck / not PAID](${local.runbook_base}#b-payments-stuck--not-paid)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.payment_confirming_stuck, google_project_service.apis]
}

resource "google_monitoring_alert_policy" "ticket_sla_breached" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals support ticket SLA breached"
  combiner     = "OR"

  conditions {
    display_name = "ticket.sla_breached"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-ticket-sla-breached\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Support ticket past 2h SLA. See Admin → Tickets (SLA past due) and [RUNBOOK §5](${local.runbook_base}#5-order-support-lookup-first-tool)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.ticket_sla_breached, google_project_service.apis]
}

resource "google_monitoring_alert_policy" "settlement_batch_failed" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals EOD settlement failure"
  combiner     = "OR"

  conditions {
    display_name = "settlement.batch_failed"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-settlement-batch-failed\""
      duration        = "0s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "EOD settlement.batch_failed. See [RUNBOOK §3 Scheduled jobs](${local.runbook_base}#3-scheduled-jobs) and [§6.G Settlements / Route blocked](${local.runbook_base}#g-settlements--route-blocked-rbi)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.settlement_batch_failed, google_project_service.apis]
}

# Cut-off jobs tick every ~15m; no cutoff.reached for 1h means the lock path is broken.
resource "google_monitoring_alert_policy" "cutoff_reached_absent" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals cutoff.reached missing"
  combiner     = "OR"

  conditions {
    display_name = "No cutoff.reached for 1h"
    condition_absent {
      filter   = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-cutoff-reached\""
      duration = "3600s"
      aggregations {
        alignment_period     = "300s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "No `cutoff.reached` after the lunch/meal cut-off window (absent 1h). See [RUNBOOK §3 Scheduled jobs](${local.runbook_base}#3-scheduled-jobs) and [§6.D Cut-off or EOD missed](${local.runbook_base}#d-cut-off-or-eod-missed)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.cutoff_reached, google_project_service.apis]
}

# EOD is daily ~21:00 IST; expect settlement.batch_completed within 1h of that run.
# Absence over ~25h catches a missed day without paging every hour outside the EOD window.
resource "google_monitoring_alert_policy" "settlement_batch_completed_absent" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals settlement.batch_completed missing after EOD"
  combiner     = "OR"

  conditions {
    display_name = "No settlement.batch_completed within ~25h (expect within 1h of EOD)"
    condition_absent {
      filter   = "resource.type = \"cloud_run_revision\" AND metric.type = \"logging.googleapis.com/user/${local.log_metric_prefix}-settlement-batch-completed\""
      duration = "90000s"
      aggregations {
        alignment_period     = "3600s"
        per_series_aligner   = "ALIGN_DELTA"
        cross_series_reducer = "REDUCE_SUM"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Expect `settlement.batch_completed` within 1h after EOD (21:00 IST). This policy fires if none is seen for ~25h (missed day). See [RUNBOOK §3](${local.runbook_base}#3-scheduled-jobs) and [§6.D](${local.runbook_base}#d-cut-off-or-eod-missed)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
  depends_on            = [google_logging_metric.settlement_batch_completed, google_project_service.apis]
}

# --- Ops dashboard ---

resource "google_monitoring_dashboard" "ops" {
  count = local.has_alerts ? 1 : 0

  dashboard_json = jsonencode({
    displayName = "LocalMeals ops"
    mosaicLayout = {
      columns = 12
      tiles = [
        {
          width  = 4
          height = 4
          widget = {
            title = "Request rate (api/web/worker)"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND resource.labels.service_name=monitoring.regex.full_match(\"${var.api_service_name}|${var.web_service_name}|${var.worker_service_name}\")"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.service_name"]
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "req/s", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 4
          width  = 4
          height = 4
          widget = {
            title = "5xx responses"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"run.googleapis.com/request_count\" AND metric.labels.response_code_class=\"5xx\" AND resource.labels.service_name=monitoring.regex.full_match(\"${var.api_service_name}|${var.web_service_name}|${var.worker_service_name}\")"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.service_name"]
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "5xx/s", scale = "LINEAR" }
            }
          }
        },
        {
          xPos   = 8
          width  = 4
          height = 4
          widget = {
            title = "API latency (p50/p95)"
            xyChart = {
              dataSets = [
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.api_service_name}\" AND metric.type=\"run.googleapis.com/request_latencies\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_PERCENTILE_50"
                      }
                    }
                  }
                  plotType       = "LINE"
                  legendTemplate = "p50"
                },
                {
                  timeSeriesQuery = {
                    timeSeriesFilter = {
                      filter = "resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"${var.api_service_name}\" AND metric.type=\"run.googleapis.com/request_latencies\""
                      aggregation = {
                        alignmentPeriod    = "60s"
                        perSeriesAligner   = "ALIGN_DELTA"
                        crossSeriesReducer = "REDUCE_PERCENTILE_95"
                      }
                    }
                  }
                  plotType       = "LINE"
                  legendTemplate = "p95"
                },
              ]
              yAxis = { label = "ms", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 4
          width  = 4
          height = 4
          widget = {
            title = "Cloud SQL CPU"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"cloudsql.googleapis.com/database/cpu/utilization\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MEAN"
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "util", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 4
          xPos   = 4
          width  = 4
          height = 4
          widget = {
            title = "Cloud SQL connections"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"cloudsql.googleapis.com/database/postgresql/num_backends\""
                    aggregation = {
                      alignmentPeriod  = "60s"
                      perSeriesAligner = "ALIGN_MAX"
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "backends", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 4
          xPos   = 8
          width  = 4
          height = 4
          widget = {
            title = "Cloud SQL disk utilization"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloudsql_database\" AND resource.labels.database_id=\"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type=\"cloudsql.googleapis.com/database/disk/utilization\""
                    aggregation = {
                      alignmentPeriod  = "300s"
                      perSeriesAligner = "ALIGN_MAX"
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "util", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 8
          width  = 4
          height = 4
          widget = {
            title = "Outbox failures"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${local.log_metric_prefix}-outbox-failed\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "events/s", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 8
          xPos   = 4
          width  = 4
          height = 4
          widget = {
            title = "Webhook signature failures"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_run_revision\" AND metric.type=\"logging.googleapis.com/user/${local.log_metric_prefix}-webhook-signature-failed\""
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "events/s", scale = "LINEAR" }
            }
          }
        },
        {
          yPos   = 8
          xPos   = 8
          width  = 4
          height = 4
          widget = {
            title = "Scheduler attempts"
            xyChart = {
              dataSets = [{
                timeSeriesQuery = {
                  timeSeriesFilter = {
                    filter = "resource.type=\"cloud_scheduler_job\" AND metric.type=\"cloudscheduler.googleapis.com/job/attempt_count\" AND resource.labels.job_id=monitoring.regex.full_match(\"${var.name_prefix}-(lunch-cutoff|eod|breakfast-cutoff|dinner-cutoff|expire-unpaid)\")"
                    aggregation = {
                      alignmentPeriod    = "60s"
                      perSeriesAligner   = "ALIGN_RATE"
                      crossSeriesReducer = "REDUCE_SUM"
                      groupByFields      = ["resource.label.job_id", "metric.label.status"]
                    }
                  }
                }
                plotType = "LINE"
              }]
              yAxis = { label = "attempts/s", scale = "LINEAR" }
            }
          }
        },
      ]
    }
  })

  depends_on = [
    google_project_service.apis,
    google_logging_metric.outbox_failed,
    google_logging_metric.webhook_signature_failed,
  ]
}
