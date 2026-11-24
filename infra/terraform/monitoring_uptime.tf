# Production-readiness monitoring: external uptime checks, Cloud SQL saturation, monthly budget.
# Prefer explicit api_url / web_url so checks work when Cloud Run is CI-managed (create_cloud_run=false).

locals {
  api_uptime_host = (
    var.api_url != ""
    ? trimsuffix(trimprefix(trimprefix(var.api_url, "https://"), "http://"), "/")
    : (
      var.api_custom_domain != ""
      ? var.api_custom_domain
      : (local.create_api ? trimprefix(google_cloud_run_v2_service.api[0].uri, "https://") : "")
    )
  )
  web_uptime_host = (
    var.web_url != ""
    ? trimsuffix(trimprefix(trimprefix(var.web_url, "https://"), "http://"), "/")
    : (
      var.web_custom_domain != ""
      ? var.web_custom_domain
      : (local.create_web ? trimprefix(google_cloud_run_v2_service.web[0].uri, "https://") : "")
    )
  )
  uptime_targets = merge(
    local.api_uptime_host != "" ? {
      api = { host = local.api_uptime_host, path = "/health" }
    } : {},
    local.web_uptime_host != "" ? {
      web = { host = local.web_uptime_host, path = "/" }
    } : {},
  )
}

resource "google_monitoring_uptime_check_config" "service" {
  for_each = local.has_alerts ? local.uptime_targets : {}

  display_name = "${var.name_prefix}-${each.key} uptime"
  timeout      = "10s"
  period       = "60s"
  # Probe from 3 continents so one regional blip does not page.
  selected_regions = ["ASIA_PACIFIC", "EUROPE", "USA_VIRGINIA"]

  http_check {
    path           = each.value.path
    port           = 443
    use_ssl        = true
    validate_ssl   = true
    request_method = "GET"
    accepted_response_status_codes {
      status_class = "STATUS_CLASS_2XX"
    }
  }

  monitored_resource {
    type = "uptime_url"
    labels = {
      project_id = var.project_id
      host       = each.value.host
    }
  }

  depends_on = [google_project_service.apis]
}

resource "google_monitoring_alert_policy" "uptime" {
  for_each = google_monitoring_uptime_check_config.service

  display_name = "LocalMeals ${each.key} DOWN"
  combiner     = "OR"

  conditions {
    display_name = "${each.key} uptime check failing"
    condition_threshold {
      filter          = "metric.type = \"monitoring.googleapis.com/uptime_check/check_passed\" AND resource.type = \"uptime_url\" AND metric.labels.check_id = \"${each.value.uptime_check_id}\""
      duration        = "120s"
      comparison      = "COMPARISON_GT"
      threshold_value = 1
      aggregations {
        alignment_period     = "60s"
        per_series_aligner   = "ALIGN_NEXT_OLDER"
        cross_series_reducer = "REDUCE_COUNT_FALSE"
        group_by_fields      = ["resource.label.host"]
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "${title(each.key)} uptime check failing. See [RUNBOOK §6.A Nobody can order](${local.runbook_base}#a-nobody-can-order)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true
}

resource "google_monitoring_alert_policy" "db_saturation" {
  count = local.has_alerts ? 1 : 0

  display_name = "LocalMeals Cloud SQL saturation"
  combiner     = "OR"

  conditions {
    display_name = "Connections near max (f1-micro ≈ 25)"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type = \"cloudsql.googleapis.com/database/postgresql/num_backends\""
      duration        = "300s"
      comparison      = "COMPARISON_GT"
      threshold_value = var.db_connections_alert_threshold
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "CPU > 85%"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type = \"cloudsql.googleapis.com/database/cpu/utilization\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.85
      aggregations {
        alignment_period   = "60s"
        per_series_aligner = "ALIGN_MEAN"
      }
      trigger {
        count = 1
      }
    }
  }

  conditions {
    display_name = "Disk > 80%"
    condition_threshold {
      filter          = "resource.type = \"cloudsql_database\" AND resource.labels.database_id = \"${var.project_id}:${google_sql_database_instance.postgres.name}\" AND metric.type = \"cloudsql.googleapis.com/database/disk/utilization\""
      duration        = "600s"
      comparison      = "COMPARISON_GT"
      threshold_value = 0.8
      aggregations {
        alignment_period   = "300s"
        per_series_aligner = "ALIGN_MAX"
      }
      trigger {
        count = 1
      }
    }
  }

  documentation {
    content   = "Cloud SQL connections/CPU/disk saturation. See [RUNBOOK §6.I High 5xx / rate-limit / DB](${local.runbook_base}#i-high-5xx--rate-limit--db)."
    mime_type = "text/markdown"
  }

  notification_channels = local.alert_channels
  enabled               = true

  depends_on = [google_project_service.apis]
}

# Needs the billing account id and roles/billing.costsManager for the applying identity.
resource "google_billing_budget" "monthly" {
  count = var.billing_account_id != "" && var.monthly_budget_inr > 0 ? 1 : 0

  billing_account = var.billing_account_id
  display_name    = "${var.name_prefix} monthly budget"

  budget_filter {
    projects = ["projects/${data.google_project.current.number}"]
  }

  amount {
    specified_amount {
      currency_code = "INR"
      units         = tostring(var.monthly_budget_inr)
    }
  }

  threshold_rules {
    threshold_percent = 0.5
  }
  threshold_rules {
    threshold_percent = 0.9
  }
  threshold_rules {
    threshold_percent = 1.0
  }
  threshold_rules {
    threshold_percent = 1.0
    spend_basis       = "FORECASTED_SPEND"
  }

  all_updates_rule {
    monitoring_notification_channels = local.has_alerts ? [google_monitoring_notification_channel.email[0].id] : []
    disable_default_iam_recipients   = false
  }

  depends_on = [google_project_service.apis]
}
