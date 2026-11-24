# Fail plan/apply when Cloud Run DB pools can exceed ~80% of Postgres max_connections.
# Formula: api_max*api_pool + worker_max*worker_pool + 3 (migrate/admin/proxy headroom).

locals {
  db_connection_budget_used = (
    var.api_max_instances * var.db_pool_max_api
    + var.worker_max_instances * var.db_pool_max_worker
    + 3
  )
  db_connection_budget_cap = floor(0.8 * var.db_max_connections)
}

check "db_connection_budget" {
  assert {
    condition = local.db_connection_budget_used <= local.db_connection_budget_cap
    error_message = <<-EOT
      DB connection budget exceeded: need ${local.db_connection_budget_used} backends
      (api ${var.api_max_instances}×${var.db_pool_max_api} + worker ${var.worker_max_instances}×${var.db_pool_max_worker} + 3)
      but 80% of db_max_connections (${var.db_max_connections}) is only ${local.db_connection_budget_cap}.
      Lower max-instances/pools or raise db_max_connections after a tier upgrade (see docs/COST.md).
    EOT
  }
}
