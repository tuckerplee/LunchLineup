# Production Terraform Tests

## Files

- `README.md`: this test-folder inventory.
- `disposable.tftest.hcl`: mocked-provider, plan-only checks using reserved test domains and documentation-only fixture addresses; it accepts exact production VM ID 217, rejects a non-217 ID, and cannot contact or mutate Proxmox, Cloudflare, DNS, or VM217.
