resource "google_vpc_access_connector" "connector" {
  name          = "${var.name_prefix}-conn"
  region        = var.region
  network       = "default"
  ip_cidr_range = var.vpc_connector_range
  min_instances = 2
  max_instances = 3

  depends_on = [google_project_service.apis]
}
