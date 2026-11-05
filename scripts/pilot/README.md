# Pilot Scripts

## Files

- `README.md`: this pilot scripts folder guide.
- `provision-pilot-tenant.mjs`: dependency-free (node built-ins plus the image's `@prisma/client`) idempotent pilot tenant provisioner; dry-run by default, `--apply` commits, refuses production-like targets, writes temporary employee PINs only to a new 0600 file. Runbook: `docs/runbooks/pilot-tenant-provisioning.md`.
