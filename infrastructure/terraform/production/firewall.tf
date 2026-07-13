resource "proxmox_virtual_environment_firewall_options" "app" {
  node_name     = proxmox_virtual_environment_vm.app.node_name
  vm_id         = proxmox_virtual_environment_vm.app.vm_id
  enabled       = true
  dhcp          = false
  ipfilter      = true
  macfilter     = true
  ndp           = false
  radv          = false
  input_policy  = "DROP"
  output_policy = "ACCEPT"
  log_level_in  = "warning"
  log_level_out = "nolog"
}

resource "proxmox_virtual_environment_firewall_options" "data" {
  node_name     = proxmox_virtual_environment_vm.data.node_name
  vm_id         = proxmox_virtual_environment_vm.data.vm_id
  enabled       = true
  dhcp          = false
  ipfilter      = true
  macfilter     = true
  ndp           = false
  radv          = false
  input_policy  = "DROP"
  output_policy = "ACCEPT"
  log_level_in  = "warning"
  log_level_out = "nolog"
}

resource "proxmox_virtual_environment_firewall_rules" "app" {
  node_name = proxmox_virtual_environment_vm.app.node_name
  vm_id     = proxmox_virtual_environment_vm.app.vm_id

  dynamic "rule" {
    for_each = var.proxmox_network.admin_source_cidrs
    content {
      type    = "in"
      action  = "ACCEPT"
      source  = rule.value
      dport   = "22"
      proto   = "tcp"
      comment = "SSH from approved administration boundary"
      log     = "info"
    }
  }

  dynamic "rule" {
    for_each = var.proxmox_network.edge_source_cidrs
    content {
      type    = "in"
      action  = "ACCEPT"
      source  = rule.value
      dport   = "80,443"
      proto   = "tcp"
      comment = "HTTP/TLS from approved edge boundary"
      log     = "info"
    }
  }

  depends_on = [proxmox_virtual_environment_firewall_options.app]
}

resource "proxmox_virtual_environment_firewall_rules" "data" {
  node_name = proxmox_virtual_environment_vm.data.node_name
  vm_id     = proxmox_virtual_environment_vm.data.vm_id

  dynamic "rule" {
    for_each = var.proxmox_network.admin_source_cidrs
    content {
      type    = "in"
      action  = "ACCEPT"
      source  = rule.value
      dport   = "22"
      proto   = "tcp"
      comment = "SSH from approved administration boundary"
      log     = "info"
    }
  }

  rule {
    type    = "in"
    action  = "ACCEPT"
    source  = split("/", var.proxmox_vms["app"].ipv4_cidr)[0]
    dport   = "5432,6379,5672"
    proto   = "tcp"
    comment = "Data services from the app VM only"
    log     = "info"
  }

  depends_on = [proxmox_virtual_environment_firewall_options.data]
}
