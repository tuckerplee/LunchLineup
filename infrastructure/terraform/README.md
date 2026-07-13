# Terraform

## Files

- `README.md`: this Terraform folder guide.
- `main.tf`: stack entrypoint catalog for available Terraform modules.

## Directories

- `production/`: production contract module with a readiness gate.

## Usage

Run production checks from `infrastructure/terraform/production`.

This folder is not production-ready by default. The production module must receive real host, image digest, DNS, backup, secrets, alerting, and runbook inputs before Terraform can produce a successful production plan.
