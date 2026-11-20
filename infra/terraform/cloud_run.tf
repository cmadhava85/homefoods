# Optional — enable with create_cloud_run=true after images are pushed.

locals {
  api_secret_env = {
    DATABASE_URL             = "DATABASE_URL"
    INTERNAL_JOB_TOKEN       = "INTERNAL_JOB_TOKEN"
    AUTH_SECRET              = "AUTH_SECRET"
    ADMIN_MOBILES            = "ADMIN_MOBILES"
    RAZORPAY_KEY_ID          = "RAZORPAY_KEY_ID"
    RAZORPAY_KEY_SECRET      = "RAZORPAY_KEY_SECRET"
    RAZORPAY_WEBHOOK_SECRET  = "RAZORPAY_WEBHOOK_SECRET"
    WHATSAPP_VERIFY_TOKEN    = "WHATSAPP_VERIFY_TOKEN"
    WHATSAPP_ACCESS_TOKEN    = "WHATSAPP_ACCESS_TOKEN"
    WHATSAPP_APP_SECRET      = "WHATSAPP_APP_SECRET"
    WHATSAPP_PHONE_NUMBER_ID = "WHATSAPP_PHONE_NUMBER_ID"
  }

  worker_secret_env = {
    DATABASE_URL             = "DATABASE_URL"
    INTERNAL_JOB_TOKEN       = "INTERNAL_JOB_TOKEN"
    WHATSAPP_VERIFY_TOKEN    = "WHATSAPP_VERIFY_TOKEN"
    WHATSAPP_ACCESS_TOKEN    = "WHATSAPP_ACCESS_TOKEN"
    WHATSAPP_APP_SECRET      = "WHATSAPP_APP_SECRET"
    WHATSAPP_PHONE_NUMBER_ID = "WHATSAPP_PHONE_NUMBER_ID"
  }

  create_api    = var.create_cloud_run && var.api_image != ""
  create_worker = var.create_cloud_run && var.worker_image != ""
  create_web    = var.create_cloud_run && var.web_image != ""
}

resource "google_cloud_run_v2_service" "api" {
  count = local.create_api ? 1 : 0

  name     = "${var.name_prefix}-api"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    service_account = google_service_account.run.email

    scaling {
      min_instance_count = var.api_min_instances
      max_instance_count = var.api_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }

    containers {
      image = var.api_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "MOCK_WHATSAPP"
        value = tostring(var.mock_whatsapp)
      }
      env {
        name  = "MOCK_PAYMENTS"
        value = tostring(var.mock_payments)
      }
      env {
        name  = "MOCK_AUTH"
        value = tostring(var.mock_auth)
      }
      env {
        name  = "AUTH_ENFORCE"
        value = tostring(var.auth_enforce)
      }
      env {
        name  = "WHATSAPP_API_VERSION"
        value = var.whatsapp_api_version
      }
      env {
        name  = "GCS_UPLOADS_BUCKET"
        value = google_storage_bucket.uploads.name
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "OTEL_ENABLED"
        value = tostring(var.otel_enabled)
      }
      env {
        name  = "DB_POOL_MAX"
        value = tostring(var.db_pool_max_api)
      }

      dynamic "env" {
        for_each = var.solo_kitchen_slug != "" ? [var.solo_kitchen_slug] : []
        content {
          name  = "SOLO_KITCHEN_SLUG"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.otel_exporter_otlp_endpoint != "" ? [var.otel_exporter_otlp_endpoint] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.web_origin != "" ? [var.web_origin] : []
        content {
          name  = "WEB_ORIGIN"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.api_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        # Bill CPU only while serving requests (solo cost).
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }
  }

  depends_on = [
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.internal_job_token,
    google_secret_manager_secret_version.auth_secret,
    google_secret_manager_secret_version.admin_mobiles,
    google_secret_manager_secret_version.placeholders,
    google_secret_manager_secret_iam_member.run_secret_accessor,
    google_project_iam_member.run_cloudsql,
    google_storage_bucket_iam_member.uploads_run_object_admin,
    google_vpc_access_connector.connector,
  ]
}

resource "google_cloud_run_v2_service_iam_member" "api_public" {
  count = local.create_api ? 1 : 0

  name     = google_cloud_run_v2_service.api[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

resource "google_cloud_run_v2_service" "worker" {
  count = local.create_worker ? 1 : 0

  name     = "${var.name_prefix}-worker"
  location = var.region
  # Worker is internal — no public ingress needed for outbox polling
  ingress = "INGRESS_TRAFFIC_INTERNAL_ONLY"

  template {
    service_account = google_service_account.run.email

    scaling {
      min_instance_count = var.worker_min_instances
      max_instance_count = var.worker_max_instances
    }

    volumes {
      name = "cloudsql"
      cloud_sql_instance {
        instances = [google_sql_database_instance.postgres.connection_name]
      }
    }

    containers {
      image = var.worker_image

      volume_mounts {
        name       = "cloudsql"
        mount_path = "/cloudsql"
      }

      env {
        name  = "NODE_ENV"
        value = "production"
      }
      env {
        name  = "MOCK_WHATSAPP"
        value = tostring(var.mock_whatsapp)
      }
      env {
        name  = "WHATSAPP_API_VERSION"
        value = var.whatsapp_api_version
      }
      env {
        name  = "ENABLE_AUTO_CUTOFF"
        value = "false"
      }
      env {
        name  = "ENABLE_AUTO_EOD"
        value = "false"
      }
      env {
        name  = "LOG_LEVEL"
        value = "info"
      }
      env {
        name  = "OTEL_ENABLED"
        value = tostring(var.otel_enabled)
      }
      env {
        name  = "CONFIRMING_STUCK_MS"
        value = tostring(var.confirming_stuck_ms)
      }
      env {
        name  = "DB_POOL_MAX"
        value = tostring(var.db_pool_max_worker)
      }
      env {
        name  = "OUTBOX_POLL_MS"
        value = tostring(var.outbox_poll_ms)
      }
      env {
        name  = "ENABLE_AUTO_RETENTION"
        value = "true"
      }

      dynamic "env" {
        for_each = var.solo_kitchen_slug != "" ? [var.solo_kitchen_slug] : []
        content {
          name  = "SOLO_KITCHEN_SLUG"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.otel_exporter_otlp_endpoint != "" ? [var.otel_exporter_otlp_endpoint] : []
        content {
          name  = "OTEL_EXPORTER_OTLP_ENDPOINT"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.create_api ? [google_cloud_run_v2_service.api[0].uri] : []
        content {
          name  = "API_INTERNAL_URL"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = local.worker_secret_env
        content {
          name = env.key
          value_source {
            secret_key_ref {
              secret  = google_secret_manager_secret.app[env.value].secret_id
              version = "latest"
            }
          }
        }
      }

      resources {
        # Worker polls continuously when min≥1 — keep CPU allocated.
        cpu_idle = false
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }

    vpc_access {
      connector = google_vpc_access_connector.connector.id
      egress    = "PRIVATE_RANGES_ONLY"
    }
  }

  depends_on = [
    google_secret_manager_secret_version.database_url,
    google_secret_manager_secret_version.internal_job_token,
    google_secret_manager_secret_version.placeholders,
    google_secret_manager_secret_iam_member.run_secret_accessor,
    google_project_iam_member.run_cloudsql,
    google_vpc_access_connector.connector,
  ]
}

resource "google_cloud_run_v2_service" "web" {
  count = local.create_web ? 1 : 0

  name     = "${var.name_prefix}-web"
  location = var.region
  ingress  = "INGRESS_TRAFFIC_ALL"

  template {
    scaling {
      min_instance_count = var.web_min_instances
      max_instance_count = var.web_max_instances
    }

    containers {
      image = var.web_image

      env {
        name  = "NODE_ENV"
        value = "production"
      }

      # Bake-time NEXT_PUBLIC_API_URL is preferred; runtime hint for any server usage
      dynamic "env" {
        for_each = var.web_public_api_url != "" ? [var.web_public_api_url] : (
          local.create_api ? [google_cloud_run_v2_service.api[0].uri] : []
        )
        content {
          name  = "NEXT_PUBLIC_API_URL"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.solo_kitchen_slug != "" ? [var.solo_kitchen_slug] : []
        content {
          name  = "SOLO_KITCHEN_SLUG"
          value = env.value
        }
      }

      dynamic "env" {
        for_each = var.solo_kitchen_slug != "" ? [var.solo_kitchen_slug] : []
        content {
          name  = "NEXT_PUBLIC_SOLO_KITCHEN_SLUG"
          value = env.value
        }
      }

      resources {
        cpu_idle = true
        limits = {
          cpu    = "1"
          memory = "512Mi"
        }
      }
    }
  }
}

resource "google_cloud_run_v2_service_iam_member" "web_public" {
  count = local.create_web ? 1 : 0

  name     = google_cloud_run_v2_service.web[0].name
  location = var.region
  role     = "roles/run.invoker"
  member   = "allUsers"
}

# Optional custom domains (DNS CNAME must point at ghs.googlehosted.com)
resource "google_cloud_run_domain_mapping" "api" {
  count = local.create_api && var.api_custom_domain != "" ? 1 : 0

  location = var.region
  name     = var.api_custom_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.api[0].name
  }
}

resource "google_cloud_run_domain_mapping" "web" {
  count = local.create_web && var.web_custom_domain != "" ? 1 : 0

  location = var.region
  name     = var.web_custom_domain

  metadata {
    namespace = var.project_id
  }

  spec {
    route_name = google_cloud_run_v2_service.web[0].name
  }
}
