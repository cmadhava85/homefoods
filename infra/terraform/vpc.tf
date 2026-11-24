# Serverless VPC Access connector — OFF by default (cost: ≥2 always-on connector VMs).
# Nothing needs it today: Cloud SQL is reached via the IAM-gated /cloudsql socket over public IP + TLS,
# and no service calls a private IP. Turn on only if you add private resources (Cloud SQL private IP,
# Memorystore, internal load balancer) — or prefer Direct VPC egress, which has no VM cost.

resource "google_vpc_access_connector" "connector" {
  count = var.vpc_connector_enabled ? 1 : 0

  name          = "${var.name_prefix}-conn"
  region        = var.region
  network       = "default"
  ip_cidr_range = var.vpc_connector_range
  min_instances = 2
  max_instances = 3

  depends_on = [google_project_service.apis]
}
