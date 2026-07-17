# Terraform

## Files

- `README.md`: this Terraform folder guide.
- `main.tf`: stack entrypoint catalog for available Terraform modules.

## Directories

- `production/`: production contract module with a readiness gate.

## Usage

Run production checks from `infrastructure/terraform/production`.

This folder is not production-ready by default. The production module accepts exactly Proxmox VM ID `217`; every other app VM ID fails input validation. It must also receive real image digest, DNS, backup, secrets, alerting, and runbook inputs before Terraform can produce a successful production plan. Terraform owns the VM217 host boundary; production Compose on VM217 is the sole current PostgreSQL/Redis/RabbitMQ data plane.
