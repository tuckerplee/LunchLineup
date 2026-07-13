terraform {
  required_version = ">= 1.10.0"

  backend "s3" {
    key          = "lunchlineup/production/terraform.tfstate"
    encrypt      = true
    use_lockfile = true
  }

  required_providers {
    proxmox = {
      source  = "bpg/proxmox"
      version = "0.111.0"
    }
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.21.1"
    }
  }
}

provider "proxmox" {
  endpoint = var.proxmox_endpoint
  insecure = false
  min_tls  = "1.3"

  ssh {
    agent    = true
    username = var.proxmox_ssh_username
  }
}

# The provider reads CLOUDFLARE_API_TOKEN only when DNS is provider-owned.
provider "cloudflare" {}
