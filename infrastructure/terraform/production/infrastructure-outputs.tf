output "provisioned_vms" {
  description = "Provider-managed VM217 identity and private address."
  value = {
    app = {
      node_name = proxmox_virtual_environment_vm.app.node_name
      vm_id     = proxmox_virtual_environment_vm.app.vm_id
      name      = proxmox_virtual_environment_vm.app.name
      ipv4_cidr = var.proxmox_vms["app"].ipv4_cidr
    }
  }
}

output "bootstrap_contracts" {
  description = "Non-secret role-specific bootstrap contracts written through cloud-init."
  value       = local.bootstrap_contracts
}

output "dns_provisioning" {
  description = "Provider-owned DNS record or accountable external ownership contract."
  value = {
    mode                      = var.dns_ownership.mode
    record_name               = var.domain_name
    record_id                 = try(cloudflare_dns_record.production[0].id, null)
    external_owner            = var.dns_ownership.mode == "external" ? var.dns_ownership.external_owner : null
    external_change_reference = var.dns_ownership.mode == "external" ? var.dns_ownership.external_change_reference : null
  }
}

output "production_topology" {
  description = "Authoritative current production data-plane contract."
  value = {
    version            = "vm217-compose-v1"
    host_role          = "app"
    runtime_owner      = "docker-compose"
    data_services      = ["pgbouncer", "postgres", "redis", "rabbitmq"]
    database_dsn_host  = "postgres"
    backup_target_host = "postgres"
    pitr_target_host   = "postgres"
    external_data_vm   = "disabled"
  }
}
