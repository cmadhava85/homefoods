terraform {
  required_version = ">= 1.5.0"

  required_providers {
    google = {
      source  = "hashicorp/google"
      version = "~> 8.12"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.6"
    }
  }

  # Remote state (versioned GCS bucket from state_bucket.tf). Bucket/prefix live in backend.hcl.
  # One-time migration from local state: see README.md "Remote state".
  backend "gcs" {}
}
