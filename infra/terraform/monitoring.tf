# MVP-1 production observability: Cloud Monitoring alerts + log-based metrics.
# Set alert_email to create the notification channel and policies.

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

# --- Alert policies ---

resource "google_monitoring_alert_policy" "api_5xx" {
  count = local.has_alerts && local.create_api ? 1 : 0

  display_name = "LocalMeals API 5xx"
  combiner     = "OR"

  conditions {
    display_name = "Cloud Run api 5xx count"
    condition_threshold {
      filter          = "resource.type = \"cloud_run_revision\" AND resource.labels.service_name = \"${var.name_prefix}-api\" AND metric.type = \"run.googleapis.com/request_count\" AND metric.labels.response_code_class = \"5xx\""
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
  enabled               = true
  depends_on            = [google_logging_metric.outbox_failed, google_project_service.apis]
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
  enabled               = true
  depends_on            = [google_logging_metric.payment_confirming_stuck, google_project_service.apis]
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

  notification_channels = [google_monitoring_notification_channel.email[0].id]
  enabled               = true
  depends_on            = [google_logging_metric.settlement_batch_failed, google_project_service.apis]
}
