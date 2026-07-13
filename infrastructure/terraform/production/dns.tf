resource "cloudflare_dns_record" "production" {
  count = var.dns_ownership.mode == "cloudflare" ? 1 : 0

  zone_id = var.dns_ownership.cloudflare_zone_id
  name    = var.domain_name
  type    = "A"
  content = var.dns_ownership.record_content
  ttl     = var.dns_ownership.proxied ? 1 : var.dns_ownership.ttl
  proxied = var.dns_ownership.proxied
  comment = "Owned by LunchLineUp production Terraform"
  tags    = ["environment:production", "managed-by:terraform", "owner:lunchlineup"]

  lifecycle {
    precondition {
      condition     = local.infrastructure_inputs_ready && length(local.missing_required_inputs) == 0
      error_message = "Production DNS planning is blocked by incomplete infrastructure/readiness inputs."
    }
  }

  depends_on = [terraform_data.production_readiness_gate]
}
