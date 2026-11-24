# Off-project / cross-bucket Cloud SQL export stub (OPS_READINESS P2-14).
# Set backup_export_bucket = "gs://OTHER_PROJECT-localmeals-sql-exports" when ready.
# Weekly export + 90-day object lifecycle are intentionally not wired yet — enable after
# the destination bucket exists in a separate project and IAM for the SQL SA is granted.

locals {
  backup_export_configured = var.backup_export_bucket != ""
}

# Placeholder so plans show intent when the variable is set.
output "backup_export_bucket" {
  description = "Configured weekly SQL export destination (empty until off-project bucket is ready)"
  value       = var.backup_export_bucket
}

check "backup_export_bucket_format" {
  assert {
    condition = (
      !local.backup_export_configured
      || can(regex("^gs://[a-z0-9][a-z0-9._-]+[a-z0-9](/.*)?$", var.backup_export_bucket))
    )
    error_message = "backup_export_bucket must be empty or a gs://bucket[/prefix] URI."
  }
}
