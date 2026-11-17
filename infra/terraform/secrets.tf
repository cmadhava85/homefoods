locals {
  secret_ids = [
    "DATABASE_URL",
    "INTERNAL_JOB_TOKEN",
    "AUTH_SECRET",
    "ADMIN_MOBILES",
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_PHONE_NUMBER_ID",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
  ]
}

resource "google_secret_manager_secret" "app" {
  for_each = toset(local.secret_ids)

  secret_id = each.value
  replication {
    auto {}
  }

  depends_on = [google_project_service.apis]
}

resource "random_password" "internal_job_token" {
  length  = 48
  special = false
}

resource "random_password" "auth_secret" {
  length  = 48
  special = false
}

resource "google_secret_manager_secret_version" "database_url" {
  secret      = google_secret_manager_secret.app["DATABASE_URL"].id
  secret_data = local.database_url
}

resource "google_secret_manager_secret_version" "internal_job_token" {
  secret      = google_secret_manager_secret.app["INTERNAL_JOB_TOKEN"].id
  secret_data = random_password.internal_job_token.result
}

resource "google_secret_manager_secret_version" "auth_secret" {
  secret      = google_secret_manager_secret.app["AUTH_SECRET"].id
  secret_data = random_password.auth_secret.result

  lifecycle {
    ignore_changes = [secret_data]
  }
}

resource "google_secret_manager_secret_version" "admin_mobiles" {
  secret      = google_secret_manager_secret.app["ADMIN_MOBILES"].id
  secret_data = var.admin_mobiles

  lifecycle {
    ignore_changes = [secret_data]
  }
}

# Placeholders so Cloud Run can reference secrets; replace versions when wiring Meta/Razorpay
resource "google_secret_manager_secret_version" "placeholders" {
  for_each = toset([
    "WHATSAPP_VERIFY_TOKEN",
    "WHATSAPP_ACCESS_TOKEN",
    "WHATSAPP_APP_SECRET",
    "WHATSAPP_PHONE_NUMBER_ID",
    "RAZORPAY_KEY_ID",
    "RAZORPAY_KEY_SECRET",
    "RAZORPAY_WEBHOOK_SECRET",
  ])

  secret      = google_secret_manager_secret.app[each.value].id
  secret_data = "REPLACE_ME"

  lifecycle {
    ignore_changes = [secret_data]
  }
}
