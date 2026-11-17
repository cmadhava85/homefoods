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
  description = "Keep ≥1 so outbox polling stays warm in staging"
  default     = 1
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
