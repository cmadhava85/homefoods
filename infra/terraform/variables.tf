variable "project_id" {
  type        = string
  description = "GCP project id"
  default     = "home-food-513806"
}

variable "region" {
  type        = string
  description = "Primary region (Mumbai for TN)"
  default     = "asia-south1"
}

variable "name_prefix" {
  type        = string
  description = "Resource name prefix"
  default     = "localmeals"
}

variable "db_tier" {
  type        = string
  description = "Cloud SQL machine tier (ENTERPRISE edition)"
  default     = "db-f1-micro"
}

variable "db_disk_size_gb" {
  type    = number
  default = 10
}

variable "vpc_connector_range" {
  type        = string
  description = "CIDR for Serverless VPC Access connector"
  default     = "10.8.0.0/28"
}

variable "enable_apis" {
  type        = bool
  description = "Manage project service enablement via Terraform"
  default     = true
}

variable "create_cloud_run" {
  type        = bool
  description = "Create Cloud Run services (needs images first)"
  default     = false
}

variable "api_image" {
  type    = string
  default = ""
}

variable "worker_image" {
  type    = string
  default = ""
}

variable "web_image" {
  type    = string
  default = ""
}

variable "web_public_api_url" {
  type        = string
  description = "NEXT_PUBLIC_API_URL baked into web (set when deploying web)"
  default     = ""
}

variable "mock_payments" {
  type        = bool
  description = "When false, API uses live Razorpay (Payment Links + refunds + Route transfers)"
  default     = true
}

variable "mock_whatsapp" {
  type        = bool
  description = "When false, API/worker use Meta Cloud API"
  default     = true
}

variable "mock_auth" {
  type        = bool
  description = "When false, phone OTP is enforced (dev OTP disabled)"
  default     = true
}

variable "auth_enforce" {
  type        = bool
  description = "When true, admin ops routes require Bearer auth (kitchen mutators always require auth)"
  default     = true
}

variable "admin_mobiles" {
  type        = string
  description = "Comma-separated admin mobiles for AUTH (initial Secret Manager value)"
  default     = "+919900000001"
}

variable "whatsapp_api_version" {
  type    = string
  default = "v21.0"
}

variable "web_origin" {
  type        = string
  description = "Public web origin for Razorpay payment-link callbacks / CORS"
  default     = ""
}

variable "worker_min_instances" {
  type        = number
  description = "Prod solo: 1 (outbox). Staging sleep: 0. API/web stay at 0."
  default     = 1
}

variable "api_min_instances" {
  type        = number
  description = "Keep 0 for solo cost (scale to zero)"
  default     = 0
}

variable "web_min_instances" {
  type        = number
  description = "Keep 0 for solo cost (scale to zero)"
  default     = 0
}

variable "api_max_instances" {
  type    = number
  default = 3
}

variable "web_max_instances" {
  type    = number
  default = 3
}

variable "worker_max_instances" {
  type    = number
  default = 2
}

variable "db_disk_autoresize_limit_gb" {
  type        = number
  description = "Cap Cloud SQL disk growth (solo launch)"
  default     = 20
}

variable "create_pubsub" {
  type        = bool
  description = "Create Pub/Sub topics (unused while worker polls DB outbox). Off for solo."
  default     = false
}

variable "solo_kitchen_slug" {
  type        = string
  description = "Temporary single-kitchen launch slug (empty = multi-cook). Sets SOLO_KITCHEN_SLUG on API/web."
  default     = "csk-homemade-delights"
}

variable "uploads_nearline_days" {
  type        = number
  description = "Move uploads objects to Nearline after N days (0 = disable)"
  default     = 30
}

variable "uploads_delete_days" {
  type        = number
  description = "Delete uploads objects after N days (0 = never). Concern photos age out; raise if menus must live forever."
  default     = 180
}

variable "artifact_keep_versions" {
  type        = number
  description = "Artifact Registry: keep this many recent image versions per package"
  default     = 5
}

variable "db_pool_max_api" {
  type        = number
  description = "API postgres.js pool size (Cloud SQL f1-micro)"
  default     = 5
}

variable "db_pool_max_worker" {
  type        = number
  description = "Worker postgres.js pool size"
  default     = 2
}

variable "outbox_poll_ms" {
  type        = number
  description = "Worker outbox poll interval (higher = less CPU on always-on worker)"
  default     = 5000
}

variable "create_scheduler" {
  type        = bool
  description = "Create cut-off + EOD Cloud Scheduler jobs (needs create_cloud_run + api_image)"
  default     = true
}

variable "lunch_cutoff_schedule" {
  type        = string
  description = "Cron for lunch cut-off (Asia/Kolkata)"
  default     = "0 8 * * *"
}

variable "eod_schedule" {
  type        = string
  description = "Cron for EOD settlement (Asia/Kolkata)"
  default     = "0 18 * * *"
}

variable "api_custom_domain" {
  type        = string
  description = "Optional custom domain for API (e.g. api.localmeals.in)"
  default     = ""
}

variable "web_custom_domain" {
  type        = string
  description = "Optional custom domain for web (e.g. app.localmeals.in)"
  default     = ""
}

variable "alert_email" {
  type        = string
  description = "Ops email for Monitoring alerts (empty = no alert policies)"
  default     = ""
}

variable "otel_enabled" {
  type        = bool
  description = "Enable OpenTelemetry traces on API + worker (needs OTLP endpoint)"
  default     = false
}

variable "otel_exporter_otlp_endpoint" {
  type        = string
  description = "OTLP HTTP traces endpoint (empty = SDK default)"
  default     = ""
}

variable "confirming_stuck_ms" {
  type        = number
  description = "Worker alerts when CONFIRMING_PAYMENT older than this many ms"
  default     = 900000
}

variable "create_tf_state_bucket" {
  type        = bool
  description = "Create GCS bucket for Terraform remote state"
  default     = false
}

variable "tf_state_bucket_name" {
  type        = string
  description = "GCS bucket name when create_tf_state_bucket=true"
  default     = "home-food-513806-tfstate"
}

variable "create_github_wif" {
  type        = bool
  description = "Create GitHub Actions WIF pool + deploy service account"
  default     = false
}

variable "github_repository" {
  type        = string
  description = "GitHub repo allowed to deploy (OWNER/REPO)"
  default     = ""
}
