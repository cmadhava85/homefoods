data "google_project" "current" {
  project_id = var.project_id
}

# Required for dead-letter delivery from subscriptions
resource "google_pubsub_topic_iam_member" "dead_letter_publisher" {
  count = var.create_pubsub ? 1 : 0

  topic  = google_pubsub_topic.dead_letter[0].name
  role   = "roles/pubsub.publisher"
  member = "serviceAccount:service-${data.google_project.current.number}@gcp-sa-pubsub.iam.gserviceaccount.com"
}
