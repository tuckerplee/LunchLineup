terraform {
  required_version = ">= 1.6.0"
}

locals {
  stack_entrypoints = {
    production = {
      path        = "./production"
      status      = "blocked_until_real_inputs_are_supplied"
      description = "Production contract module with an intentional readiness gate."
    }
  }
}

output "stack_entrypoints" {
  description = "Terraform stack entrypoints available from this folder."
  value       = local.stack_entrypoints
}
