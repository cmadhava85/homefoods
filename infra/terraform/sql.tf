resource "random_password" "db" {
  length  = 32
  special = false
}

resource "google_sql_database_instance" "postgres" {
  name             = "${var.name_prefix}-pg"
  database_version = "POSTGRES_16"
  region           = var.region

  settings {
    tier              = var.db_tier
    edition           = "ENTERPRISE"
    availability_type = "ZONAL"
    disk_size         = var.db_disk_size_gb
    disk_autoresize   = true

    backup_configuration {
      enabled    = true
      start_time = "18:00"
    }

    ip_configuration {
      ipv4_enabled = true
      # Prefer private IP + Cloud SQL connector from Cloud Run in a later harden pass
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
