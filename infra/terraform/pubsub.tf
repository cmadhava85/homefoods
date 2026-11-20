# Optional — worker uses DB outbox today. Keep Pub/Sub off for solo launch
# (set create_pubsub=true only when migrating off outbox polling).

locals {
  pubsub_events = var.create_pubsub ? toset([
    "order-created",
    "order-paid",
    "order-cancelled",
    "order-refunded",
    "cutoff-reached",
    "settlement-batch-completed",
  ]) : toset([])
}

resource "google_pubsub_topic" "events" {
  for_each = local.pubsub_events
  name     = "${var.name_prefix}.${each.value}"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_topic" "dead_letter" {
  count = var.create_pubsub ? 1 : 0
  name  = "${var.name_prefix}.dead-letter"

  depends_on = [google_project_service.apis]
}

resource "google_pubsub_subscription" "worker" {
  for_each = local.pubsub_events

  name  = "${var.name_prefix}-worker-${each.value}"
  topic = google_pubsub_topic.events[each.value].name

  ack_deadline_seconds       = 60
  message_retention_duration = "604800s" # 7d

  dead_letter_policy {
    dead_letter_topic     = google_pubsub_topic.dead_letter[0].id
    max_delivery_attempts = 5
  }

  retry_policy {
    minimum_backoff = "10s"
    maximum_backoff = "600s"
  }
}
