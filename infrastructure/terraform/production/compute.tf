locals {
  bootstrap_contracts = {
    for role, target in var.proxmox_vms : role => {
      version              = 1
      environment          = var.environment
      role                 = role
      hostname             = target.name
      app_dir              = var.bootstrap_provisioning.app_dir
      release_source_sha   = var.bootstrap_provisioning.release_source_sha
      release_manifest_uri = var.bootstrap_provisioning.release_manifest_uri
      secrets_backend_uri  = var.secrets_backend
      runtime_env_path     = var.bootstrap_provisioning.runtime_env_path
      image_digests        = var.image_digests
    }
  }
}

resource "proxmox_virtual_environment_file" "cloud_init" {
  for_each = var.proxmox_vms

  content_type = "snippets"
  datastore_id = var.proxmox_cloud_init.datastore_id
  node_name    = each.value.node_name

  source_raw {
    data = templatefile("${path.module}/cloud-init.yaml.tftpl", {
      app_dir                = var.bootstrap_provisioning.app_dir
      bootstrap_artifact_url = var.proxmox_cloud_init.bootstrap_artifact_url
      bootstrap_contract_b64 = base64encode(jsonencode(local.bootstrap_contracts[each.key]))
      bootstrap_sha256       = var.proxmox_cloud_init.bootstrap_sha256
      role                   = each.key
    })
    file_name = "lunchlineup-${each.key}-${substr(var.proxmox_cloud_init.bootstrap_sha256, 0, 12)}.yaml"
  }
}

resource "proxmox_virtual_environment_vm" "data" {
  name        = var.proxmox_vms["data"].name
  description = "LunchLineUp production data; template ${var.proxmox_template.revision}; release ${var.bootstrap_provisioning.release_source_sha}"
  node_name   = var.proxmox_vms["data"].node_name
  vm_id       = var.proxmox_vms["data"].vm_id
  tags        = ["data", "lunchlineup", "production", "terraform"]

  started                              = true
  on_boot                              = true
  protection                           = true
  stop_on_destroy                      = true
  purge_on_destroy                     = false
  delete_unreferenced_disks_on_destroy = false
  scsi_hardware                        = "virtio-scsi-single"

  startup {
    order      = 1
    up_delay   = 30
    down_delay = 60
  }

  agent {
    enabled = true
    trim    = true
  }

  clone {
    node_name    = var.proxmox_template.node_name
    vm_id        = var.proxmox_template.vm_id
    datastore_id = var.proxmox_vms["data"].boot_datastore
    full          = true
    retries       = 3
  }

  cpu {
    cores = var.proxmox_vms["data"].cores
    type  = "x86-64-v2-AES"
  }

  memory {
    dedicated = var.proxmox_vms["data"].memory_mb
    floating  = var.proxmox_vms["data"].memory_mb
  }

  disk {
    datastore_id = var.proxmox_vms["data"].boot_datastore
    interface    = "scsi0"
    size         = var.proxmox_vms["data"].boot_disk_gb
    backup       = true
    discard      = "on"
    iothread     = true
    replicate    = true
    ssd          = true
  }

  disk {
    datastore_id = var.proxmox_vms["data"].data_datastore
    interface    = "scsi1"
    size         = var.proxmox_vms["data"].data_disk_gb
    backup       = true
    discard      = "on"
    iothread     = true
    replicate    = true
    ssd          = true
    serial       = "LL-PROD-DATA"
  }

  initialization {
    datastore_id = var.proxmox_cloud_init.datastore_id
    upgrade      = false

    dns {
      servers = var.proxmox_cloud_init.dns_servers
    }

    ip_config {
      ipv4 {
        address = var.proxmox_vms["data"].ipv4_cidr
        gateway = var.proxmox_network.gateway
      }
    }

    user_data_file_id = proxmox_virtual_environment_file.cloud_init["data"].id
  }

  network_device {
    bridge   = var.proxmox_network.bridge
    firewall = true
    model    = "virtio"
    vlan_id  = var.proxmox_network.vlan_id
  }

  operating_system {
    type = "l26"
  }

  serial_device {
    device = "socket"
  }

  lifecycle {
    prevent_destroy = true

    precondition {
      condition     = local.infrastructure_inputs_ready && length(local.missing_required_inputs) == 0
      error_message = "Production data VM planning is blocked by incomplete infrastructure/readiness inputs."
    }

    precondition {
      condition     = var.proxmox_vms["data"].data_disk_gb > 0
      error_message = "The data VM requires a persistent scsi1 disk."
    }
  }

  depends_on = [terraform_data.production_readiness_gate]
}

resource "proxmox_virtual_environment_vm" "app" {
  name        = var.proxmox_vms["app"].name
  description = "LunchLineUp production app; template ${var.proxmox_template.revision}; release ${var.bootstrap_provisioning.release_source_sha}"
  node_name   = var.proxmox_vms["app"].node_name
  vm_id       = var.proxmox_vms["app"].vm_id
  tags        = ["app", "lunchlineup", "production", "terraform"]

  started                              = true
  on_boot                              = true
  protection                           = false
  stop_on_destroy                      = true
  purge_on_destroy                     = false
  delete_unreferenced_disks_on_destroy = false
  scsi_hardware                        = "virtio-scsi-single"

  startup {
    order      = 2
    up_delay   = 30
    down_delay = 30
  }

  agent {
    enabled = true
    trim    = true
  }

  clone {
    node_name    = var.proxmox_template.node_name
    vm_id        = var.proxmox_template.vm_id
    datastore_id = var.proxmox_vms["app"].boot_datastore
    full          = true
    retries       = 3
  }

  cpu {
    cores = var.proxmox_vms["app"].cores
    type  = "x86-64-v2-AES"
  }

  memory {
    dedicated = var.proxmox_vms["app"].memory_mb
    floating  = var.proxmox_vms["app"].memory_mb
  }

  disk {
    datastore_id = var.proxmox_vms["app"].boot_datastore
    interface    = "scsi0"
    size         = var.proxmox_vms["app"].boot_disk_gb
    backup       = true
    discard      = "on"
    iothread     = true
    replicate    = true
    ssd          = true
  }

  initialization {
    datastore_id = var.proxmox_cloud_init.datastore_id
    upgrade      = false

    dns {
      servers = var.proxmox_cloud_init.dns_servers
    }

    ip_config {
      ipv4 {
        address = var.proxmox_vms["app"].ipv4_cidr
        gateway = var.proxmox_network.gateway
      }
    }

    user_data_file_id = proxmox_virtual_environment_file.cloud_init["app"].id
  }

  network_device {
    bridge   = var.proxmox_network.bridge
    firewall = true
    model    = "virtio"
    vlan_id  = var.proxmox_network.vlan_id
  }

  operating_system {
    type = "l26"
  }

  serial_device {
    device = "socket"
  }

  lifecycle {
    precondition {
      condition     = local.infrastructure_inputs_ready && length(local.missing_required_inputs) == 0
      error_message = "Production app VM planning is blocked by incomplete infrastructure/readiness inputs."
    }
  }

  depends_on = [terraform_data.production_readiness_gate]
}
