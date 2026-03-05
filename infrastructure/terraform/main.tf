# infrastructure/terraform/main.tf
# This is a placeholder for the Terraform IaC definitions
# In a real scenario, this would define the Ryzen server resources, 
# Docker Swarm/K3s clusters, and networking.

terraform {
  required_providers {
    docker = {
      source  = "kreuzwerker/docker"
      version = "~> 3.0.1"
    }
  }
}

provider "docker" {
  host = "unix:///var/run/docker.sock"
}

# Example: Create a Docker network for the app
resource "docker_network" "app_network" {
  name = "lunchlineup-app"
}
