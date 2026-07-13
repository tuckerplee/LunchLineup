output "provisioned_vms" {
  description = "Provider-managed VM identities and private addresses."
  value = {
    app = {
      node_name = proxmox_virtual_environment_vm.app.node_name
      vm_id     = proxmox_virtual_environment_vm.app.vm_id
      name      = proxmox_virtual_environment_vm.app.name
      ipv4_cidr = var.proxmox_vms["app"].ipv4_cidr
    }
    data = {
      node_name = proxmox_virtual_environment_vm.data.node_name
      vm_id     = proxmox_virtual_environment_vm.data.vm_id
      name      = proxmox_virtual_environment_vm.data.name
      ipv4_cidr = var.proxmox_vms["data"].ipv4_cidr
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

output "persistent_data_disk" {
  description = "Persistent data disk contract protected from Terraform destroy."
  value       = "${var.proxmox_vms["data"].node_name}/${var.proxmox_vms["data"].vm_id}/scsi1"
}
