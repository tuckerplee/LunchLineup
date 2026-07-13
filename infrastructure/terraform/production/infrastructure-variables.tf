variable "proxmox_endpoint" {
  description = "TLS-verified Proxmox API endpoint. Authentication comes from PROXMOX_VE_API_TOKEN."
  type        = string

  validation {
    condition     = can(regex("^https://[^/ ]+:8006/?$", var.proxmox_endpoint))
    error_message = "proxmox_endpoint must be an HTTPS Proxmox API endpoint on port 8006."
  }
}

variable "proxmox_ssh_username" {
  description = "PAM username used through SSH agent for cloud-init snippet upload; this is not a credential."
  type        = string

  validation {
    condition     = can(regex("^[a-z_][a-z0-9_-]*$", var.proxmox_ssh_username))
    error_message = "proxmox_ssh_username must be a Linux account name."
  }
}

variable "proxmox_template" {
  description = "Immutable cloud-image template contract. revision changes whenever the template bytes change."
  type = object({
    node_name = string
    vm_id     = number
    revision  = string
  })

  validation {
    condition = (
      trimspace(var.proxmox_template.node_name) != "" &&
      var.proxmox_template.vm_id >= 100 &&
      can(regex("^sha256:[0-9a-f]{64}$", var.proxmox_template.revision))
    )
    error_message = "proxmox_template requires a node, VM ID >= 100, and sha256:<64 lowercase hex> revision."
  }
}

variable "proxmox_cloud_init" {
  description = "Cloud-init datastore and immutable bootstrap artifact."
  type = object({
    datastore_id           = string
    bootstrap_artifact_url = string
    bootstrap_sha256       = string
    dns_servers            = list(string)
  })

  validation {
    condition = (
      trimspace(var.proxmox_cloud_init.datastore_id) != "" &&
      can(regex("^https://[^ ]+$", var.proxmox_cloud_init.bootstrap_artifact_url)) &&
      can(regex("^[0-9a-f]{64}$", var.proxmox_cloud_init.bootstrap_sha256)) &&
      length(var.proxmox_cloud_init.dns_servers) > 0 &&
      alltrue([for address in var.proxmox_cloud_init.dns_servers : can(cidrhost(format("%s/32", address), 0))])
    )
    error_message = "proxmox_cloud_init requires a datastore, immutable HTTPS bootstrap artifact/hash, and IPv4 DNS servers."
  }
}

variable "proxmox_vms" {
  description = "Exact app and data VM definitions supplied by the estate owner."
  type = map(object({
    node_name      = string
    vm_id          = number
    name           = string
    ipv4_cidr      = string
    cores          = number
    memory_mb      = number
    boot_disk_gb   = number
    data_disk_gb   = number
    boot_datastore = string
    data_datastore = string
  }))

  validation {
    condition = (
      setequals(toset(keys(var.proxmox_vms)), toset(["app", "data"])) &&
      alltrue([
        for role, target in var.proxmox_vms :
        trimspace(target.node_name) != "" &&
        target.vm_id >= 100 &&
        can(regex("^[a-z0-9][a-z0-9-]*[a-z0-9]$", target.name)) &&
        can(cidrhost(target.ipv4_cidr, 0)) &&
        target.cores >= 2 &&
        target.memory_mb >= 2048 &&
        target.boot_disk_gb >= 16 &&
        target.data_disk_gb >= (role == "data" ? 16 : 0) &&
        trimspace(target.boot_datastore) != "" &&
        trimspace(target.data_datastore) != ""
      ])
    )
    error_message = "proxmox_vms must contain exact app/data definitions and minimum resource bounds."
  }
}

variable "proxmox_network" {
  description = "Private VLAN, gateway, and source boundaries for the production VMs."
  type = object({
    bridge             = string
    vlan_id            = number
    private_cidr       = string
    gateway            = string
    admin_source_cidrs = list(string)
    edge_source_cidrs  = list(string)
  })

  validation {
    condition = (
      trimspace(var.proxmox_network.bridge) != "" &&
      var.proxmox_network.vlan_id >= 1 && var.proxmox_network.vlan_id <= 4094 &&
      can(cidrhost(var.proxmox_network.private_cidr, 1)) &&
      can(cidrhost(format("%s/32", var.proxmox_network.gateway), 0)) &&
      length(var.proxmox_network.admin_source_cidrs) > 0 &&
      length(var.proxmox_network.edge_source_cidrs) > 0 &&
      alltrue([for cidr in concat(var.proxmox_network.admin_source_cidrs, var.proxmox_network.edge_source_cidrs) : can(cidrhost(cidr, 0))])
    )
    error_message = "proxmox_network requires an explicit bridge/VLAN/private CIDR/gateway and admin/edge source CIDRs."
  }
}

variable "bootstrap_provisioning" {
  description = "Non-secret inputs consumed by the immutable bootstrap artifact."
  type = object({
    app_dir              = string
    release_source_sha   = string
    release_manifest_uri = string
    runtime_env_path     = string
  })

  validation {
    condition = (
      startswith(var.bootstrap_provisioning.app_dir, "/") &&
      can(regex("^[0-9a-f]{40}$", var.bootstrap_provisioning.release_source_sha)) &&
      can(regex("^https://[^ ]+$", var.bootstrap_provisioning.release_manifest_uri)) &&
      startswith(var.bootstrap_provisioning.runtime_env_path, "/")
    )
    error_message = "bootstrap_provisioning requires absolute paths and an immutable release SHA/manifest."
  }
}

variable "dns_ownership" {
  description = "Cloudflare provisions DNS; external mode requires an accountable owner and change reference."
  type = object({
    mode                      = string
    cloudflare_zone_id        = string
    record_content            = string
    ttl                       = number
    proxied                   = bool
    external_owner            = string
    external_change_reference = string
  })

  validation {
    condition = (
      contains(["cloudflare", "external"], var.dns_ownership.mode) &&
      can(cidrhost(format("%s/32", var.dns_ownership.record_content), 0)) &&
      var.dns_ownership.ttl >= 60 &&
      (var.dns_ownership.mode != "cloudflare" || can(regex("^[0-9a-f]{32}$", var.dns_ownership.cloudflare_zone_id))) &&
      (var.dns_ownership.mode != "external" || (
        trimspace(var.dns_ownership.external_owner) != "" &&
        trimspace(var.dns_ownership.external_change_reference) != ""
      ))
    )
    error_message = "dns_ownership must select Cloudflare with a zone ID or external with owner/change reference."
  }
}

locals {
  infrastructure_inputs_ready = (
    trimspace(var.network_cidr) == trimspace(var.proxmox_network.private_cidr) &&
    cidrcontains(var.proxmox_network.private_cidr, var.proxmox_network.gateway) &&
    alltrue([
      for role, target in var.proxmox_vms :
      cidrcontains(var.proxmox_network.private_cidr, split("/", target.ipv4_cidr)[0]) &&
      length([
        for declared_target in var.vm_targets : declared_target
        if declared_target.role == role &&
        declared_target.name == target.name &&
        declared_target.address == split("/", target.ipv4_cidr)[0]
      ]) == 1
    ]) &&
    (
      var.dns_ownership.mode == "cloudflare" ||
      (
        trimspace(var.dns_ownership.external_owner) != "" &&
        trimspace(var.dns_ownership.external_change_reference) != ""
      )
    )
  )
}
