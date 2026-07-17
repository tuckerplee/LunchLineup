# These values exist only inside Terraform's mocked, in-memory test state.
# They are not production estate assignments and terraform apply is never used.
mock_provider "proxmox" {}
mock_provider "cloudflare" {}

variables {
  production_apply_enabled = true
  environment              = "production"
  domain_name              = "lunchlineup.terraform.test"

  image_digests = {
    api     = "registry.terraform.test/api@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
    web     = "registry.terraform.test/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    engine  = "registry.terraform.test/engine@sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc"
    worker  = "registry.terraform.test/worker@sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"
    control = "registry.terraform.test/control@sha256:eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"
    migrate = "registry.terraform.test/migrate@sha256:ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff"
  }

  vm_targets = [
    {
      name        = "terraform-fixture-app"
      address     = "10.77.0.10"
      role        = "app"
      ssh_user    = "lunchlineup"
      data_volume = "/srv/lunchlineup"
    },
  ]

  network_cidr             = "10.77.0.0/24"
  secrets_backend          = "vault://kv/terraform-fixture"
  backup_repository        = "s3://terraform-fixture/lunchlineup"
  backup_metrics_collector = "node-exporter-textfile:/var/lib/node_exporter/textfile_collector/lunchlineup_backup.prom"
  alert_targets            = ["webhook:https://alerts.terraform.test/lunchlineup"]
  operator_runbook_url     = "docs/runbooks/production-readiness.md"

  proxmox_endpoint     = "https://pve.terraform.test:8006/"
  proxmox_ssh_username = "terraform"

  proxmox_template = {
    node_name = "pve-fixture"
    vm_id     = 9000
    revision  = "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  }

  proxmox_cloud_init = {
    datastore_id           = "fixture-snippets"
    bootstrap_artifact_url = "https://artifacts.terraform.test/lunchlineup-bootstrap"
    bootstrap_sha256       = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
    dns_servers            = ["10.77.0.53"]
  }

  proxmox_vms = {
    app = {
      node_name      = "pve-fixture"
      vm_id          = 217
      name           = "terraform-fixture-app"
      ipv4_cidr      = "10.77.0.10/24"
      cores          = 2
      memory_mb      = 4096
      boot_disk_gb   = 32
      boot_datastore = "fixture-vm"
    }
  }

  proxmox_network = {
    bridge             = "vmbr-fixture"
    vlan_id            = 777
    private_cidr       = "10.77.0.0/24"
    gateway            = "10.77.0.1"
    admin_source_cidrs = ["10.78.0.0/24"]
    edge_source_cidrs  = ["10.79.0.0/24"]
  }

  bootstrap_provisioning = {
    app_dir              = "/opt/lunchlineup"
    release_source_sha   = "1234567890abcdef1234567890abcdef12345678"
    release_manifest_uri = "https://artifacts.terraform.test/release-manifest.json"
    runtime_env_path     = "/opt/lunchlineup-secrets/runtime.env"
  }

  dns_ownership = {
    mode                      = "external"
    cloudflare_zone_id        = ""
    record_content            = "192.0.2.10"
    ttl                       = 300
    proxied                   = false
    external_owner            = "terraform-test"
    external_change_reference = "in-memory-plan-only"
  }
}

run "disposable_provider_plan" {
  command = plan

  assert {
    condition     = output.provisioned_vms.app.vm_id == 217 && length(keys(output.provisioned_vms)) == 1
    error_message = "The mocked plan must include only the provider-backed production VM ID 217 host."
  }

  assert {
    condition     = output.dns_provisioning.mode == "external" && output.dns_provisioning.external_owner == "terraform-test"
    error_message = "The mocked plan must preserve explicit external DNS ownership."
  }

  assert {
    condition     = output.production_readiness.ready_for_plan && length(output.production_readiness.missing_required_inputs) == 0
    error_message = "The fixture must satisfy every production readiness input contract."
  }

  assert {
    condition = (
      output.production_topology.runtime_owner == "docker-compose" &&
      output.production_topology.external_data_vm == "disabled" &&
      output.production_topology.database_dsn_host == "postgres"
    )
    error_message = "The mocked plan must preserve the sole Compose data-plane owner."
  }

  assert {
    condition = (
      output.bootstrap_contracts.app.release_source_sha == "1234567890abcdef1234567890abcdef12345678" &&
      output.bootstrap_contracts.app.secrets_backend_uri == "vault://kv/terraform-fixture" &&
      output.bootstrap_contracts.app.data_plane_owner == "docker-compose"
    )
    error_message = "The mocked plan must propagate immutable release and managed-secret bootstrap inputs."
  }
}

run "reject_non_217_production_vm_id" {
  command = plan

  variables {
    proxmox_vms = {
      app = {
        node_name      = "pve-fixture"
        vm_id          = 107
        name           = "terraform-fixture-app"
        ipv4_cidr      = "10.77.0.10/24"
        cores          = 2
        memory_mb      = 4096
        boot_disk_gb   = 32
        boot_datastore = "fixture-vm"
      }
    }
  }

  expect_failures = [var.proxmox_vms]
}
