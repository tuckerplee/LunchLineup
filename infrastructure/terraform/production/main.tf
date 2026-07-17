terraform {
  required_version = ">= 1.6.0"
}

variable "production_apply_enabled" {
  description = "Must be true before this module can produce a successful production plan."
  type        = bool
  default     = false
}

variable "environment" {
  description = "Deployment environment this stack is allowed to represent."
  type        = string
  default     = "production"

  validation {
    condition     = var.environment == "production"
    error_message = "The production Terraform stack only accepts environment = \"production\"."
  }
}

variable "domain_name" {
  description = "Public DNS name that will front LunchLineUp production."
  type        = string
  default     = ""

  validation {
    condition     = var.domain_name == "" || can(regex("^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$", var.domain_name))
    error_message = "domain_name must be blank while blocked or a DNS hostname such as lunchlineup.example.com."
  }
}

variable "image_digests" {
  description = "Immutable image references keyed by service name. Required keys are api, web, engine, worker, control, and migrate."
  type        = map(string)
  default     = {}
}

variable "vm_targets" {
  description = "The single production VM217 target managed by this stack."
  type = list(object({
    name        = string
    address     = string
    role        = string
    ssh_user    = string
    data_volume = string
  }))
  default = []
}

variable "network_cidr" {
  description = "Private production network CIDR reserved for LunchLineUp services."
  type        = string
  default     = ""
}

variable "secrets_backend" {
  description = "Named secrets backend or vault path approved for production credentials."
  type        = string
  default     = ""
}

variable "backup_repository" {
  description = "Production backup repository URI or path for database and uploaded assets."
  type        = string
  default     = ""
}

variable "backup_metrics_collector" {
  description = "Production backup freshness collection target, such as node-exporter-textfile:/var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom or authenticated-metrics:https://metrics.internal.example/metrics."
  type        = string
  default     = ""
}

variable "alert_targets" {
  description = "Production alert routing targets. Use explicit non-placeholder routes such as pagerduty:, opsgenie:, webhook:https://, slack:https://, or mailto:."
  type        = list(string)
  default     = []
}

variable "operator_runbook_url" {
  description = "URL or repo path for the approved production operations runbook."
  type        = string
  default     = ""
}

locals {
  required_services   = toset(["api", "web", "engine", "worker", "control", "migrate"])
  placeholder_pattern = "(^|[^a-z0-9])(todo|tbd|change[_ -]?me|example|placeholder|dummy|none|unset|localhost|local)([^a-z0-9]|$)"

  image_digest_ready = alltrue([
    for service in local.required_services :
    contains(keys(var.image_digests), service) &&
    can(regex("^.+@sha256:[0-9a-f]{64}$", var.image_digests[service]))
  ])

  target_roles = toset([for target in var.vm_targets : target.role])

  domain_name_ready = (
    trimspace(var.domain_name) != "" &&
    can(regex("^[A-Za-z0-9][A-Za-z0-9.-]*[A-Za-z0-9]$", trimspace(var.domain_name))) &&
    !can(regex(local.placeholder_pattern, lower(trimspace(var.domain_name))))
  )

  vm_targets_ready = (
    length(var.vm_targets) == 1 &&
    local.target_roles == toset(["app"]) &&
    alltrue([
      for target in var.vm_targets :
      trimspace(target.name) != "" &&
      target.role == "app" &&
      trimspace(target.ssh_user) != "" &&
      trimspace(target.data_volume) != "" &&
      can(regex("^([A-Za-z0-9][A-Za-z0-9.-]*|[0-9]{1,3}([.][0-9]{1,3}){3})$", trimspace(target.address))) &&
      !can(regex(local.placeholder_pattern, lower(join(" ", [
        target.name,
        target.address,
        target.role,
        target.ssh_user,
        target.data_volume
      ]))))
    ])
  )

  network_cidr_ready = (
    can(cidrhost(var.network_cidr, 1)) &&
    can(regex("^(10[.]|172[.](1[6-9]|2[0-9]|3[01])[.]|192[.]168[.])", trimspace(var.network_cidr))) &&
    !contains(["0.0.0.0/0", "::/0"], trimspace(var.network_cidr))
  )

  secrets_backend_ready = (
    can(regex("^(vault|op|aws-secretsmanager|gcp-secretmanager|azure-keyvault|sops|age|bitwarden|doppler|infisical)://[^ ]+$", trimspace(var.secrets_backend))) &&
    !can(regex(local.placeholder_pattern, lower(trimspace(var.secrets_backend))))
  )

  backup_repository_ready = (
    can(regex("^(s3://[^ ]+|rclone:[^ ]+)$", trimspace(var.backup_repository))) &&
    !can(regex(local.placeholder_pattern, lower(trimspace(var.backup_repository))))
  )

  backup_metrics_collector_ready = (
    (
      can(regex("^node-exporter-textfile:/[^ ]+[.]prom$", trimspace(var.backup_metrics_collector))) ||
      can(regex("^authenticated-metrics:https://[^ ]+$", trimspace(var.backup_metrics_collector)))
    ) &&
    !can(regex(local.placeholder_pattern, lower(trimspace(var.backup_metrics_collector))))
  )

  alert_target_values_ready = alltrue([
    for target in var.alert_targets :
    trimspace(target) != "" &&
    (
      can(regex("^(pagerduty|opsgenie):[^ ]+$", trimspace(target))) ||
      can(regex("^(webhook|slack):https://[^ ]+$", trimspace(target))) ||
      can(regex("^mailto:[^@ ]+@[^@ ]+[.][^@ ]+$", trimspace(target)))
    ) &&
    !can(regex(local.placeholder_pattern, lower(trimspace(target))))
  ])

  critical_alert_route_ready = anytrue([
    for target in var.alert_targets :
    can(regex("^(pagerduty|opsgenie):[^ ]+$", trimspace(target))) ||
    can(regex("^(webhook|slack):https://[^ ]+$", trimspace(target)))
  ])

  alert_targets_ready = (
    length(var.alert_targets) > 0 &&
    local.alert_target_values_ready &&
    local.critical_alert_route_ready
  )

  operator_runbook_ready = (
    (
      startswith(trimspace(var.operator_runbook_url), "docs/runbooks/") ||
      can(regex("^https://github[.]com/tuckerplee/LunchLineup/(blob|tree)/[^ ]+/docs/runbooks/[^ ]+[.]md$", trimspace(var.operator_runbook_url)))
    ) &&
    !can(regex(local.placeholder_pattern, lower(trimspace(var.operator_runbook_url))))
  )

  required_input_status = {
    production_apply_enabled = var.production_apply_enabled
    domain_name              = local.domain_name_ready
    image_digests            = local.image_digest_ready
    vm_targets               = local.vm_targets_ready
    network_cidr             = local.network_cidr_ready
    secrets_backend          = local.secrets_backend_ready
    backup_repository        = local.backup_repository_ready
    backup_metrics_collector = local.backup_metrics_collector_ready
    alert_targets            = local.alert_targets_ready
    operator_runbook_url     = local.operator_runbook_ready
  }

  missing_required_inputs = [
    for name, ready in local.required_input_status : name
    if !ready
  ]

  service_contracts = {
    api = {
      image_digest_required = true
      needs_database        = true
      needs_queue           = true
      exposes_http          = true
      management_plane      = false
      migration_gate        = false
    }
    web = {
      image_digest_required = true
      needs_database        = false
      needs_queue           = false
      exposes_http          = true
      management_plane      = false
      migration_gate        = false
    }
    engine = {
      image_digest_required = true
      needs_database        = false
      needs_queue           = false
      exposes_http          = true
      management_plane      = false
      migration_gate        = false
    }
    worker = {
      image_digest_required = true
      needs_database        = true
      needs_queue           = true
      exposes_http          = false
      management_plane      = false
      migration_gate        = false
    }
    control = {
      image_digest_required = true
      needs_database        = false
      needs_queue           = false
      exposes_http          = true
      management_plane      = true
      migration_gate        = false
    }
    migrate = {
      image_digest_required = true
      needs_database        = true
      needs_queue           = false
      exposes_http          = false
      management_plane      = false
      migration_gate        = true
    }
  }
}

resource "terraform_data" "production_readiness_gate" {
  input = {
    environment = var.environment
    domain_name = var.domain_name
    production_topology = {
      version          = "vm217-compose-v1"
      runtime_owner    = "docker-compose"
      external_data_vm = "disabled"
    }
    service_contracts = local.service_contracts
    vm_targets        = var.vm_targets
  }

  lifecycle {
    precondition {
      condition     = length(local.missing_required_inputs) == 0
      error_message = "LunchLineUp production Terraform is intentionally blocked. Supply real production inputs before claiming readiness: ${join(", ", local.missing_required_inputs)}."
    }
  }
}

output "production_readiness" {
  description = "Readiness contract for the production Terraform stack."
  value = {
    environment             = var.environment
    ready_for_plan          = length(local.missing_required_inputs) == 0
    missing_required_inputs = local.missing_required_inputs
    observability_contract = {
      alert_targets                     = var.alert_targets
      backup_metric_name                = "lunchlineup_backup_last_success_timestamp_seconds"
      backup_metrics_collector          = var.backup_metrics_collector
      critical_alert_route_required     = true
      operator_runbook_url              = var.operator_runbook_url
      public_unauthenticated_metrics_ok = false
    }
    service_contracts = local.service_contracts
  }
}
