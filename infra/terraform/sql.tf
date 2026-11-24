resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "postgres" {
  name             = "${var.name_prefix}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier    = var.db_tier
    edition = "ENTERPRISE"
    # REGIONAL = synchronous standby in a second zone with automatic failover (~2× cost).
    availability_type = var.db_availability_type
    disk_size         = var.db_disk_size_gb
    disk_autoresize   = true
    # Solo launch: stop unbounded disk growth on f1-micro.
    disk_autoresize_limit = var.db_disk_autoresize_limit_gb

    backup_configuration {
      enabled    = true
      start_time = "18:00" # UTC = 23:30 IST, after EOD settlement
      # Point-in-time recovery: restore to any second inside the log retention window.
      point_in_time_recovery_enabled = var.db_pitr_enabled
      transaction_log_retention_days = var.db_log_retention_days
      backup_retention_settings {
        retained_backups = var.db_backup_retained_count
        retention_unit   = "COUNT"
      }
    }

    insights_config {
      query_insights_enabled  = true
      query_string_length     = 1024
      record_application_tags = false
      record_client_address   = false
    }

    ip_configuration {
      # Public IPv4 but no authorized_networks: only the IAM-gated Cloud SQL connector (/cloudsql socket
      # on Cloud Run) can reach it, and every connection must be TLS.
      # Next hardening step (needs a planned cut-over): private IP via private service access, then
      # ipv4_enabled = false.
      ipv4_enabled = true
      ssl_mode     = "ENCRYPTED_ONLY"
    }

    maintenance_window {
      day  = 7
      hour = 3
    }
  }

  deletion_protection = true

  depends_on = [google_project_service.apis]
}

resource "google_sql_database" "localmeals" {
  name     = "localmeals"
  instance = google_sql_database_instance.postgres.name
}

resource "google_sql_user" "localmeals" {
  name     = "localmeals"
  instance = google_sql_database_instance.postgres.name
  password = random_password.db.result
}

locals {
  # Cloud Run Unix-socket style connection string
  database_url = format(
    "postgres://%s:%s@/%s?host=/cloudsql/%s",
    google_sql_user.localmeals.name,
    urlencode(random_password.db.result),
    google_sql_database.localmeals.name,
    google_sql_database_instance.postgres.connection_name,
  )
}
