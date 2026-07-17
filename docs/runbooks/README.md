# Runbooks

## Files

- `README.md`: this runbooks folder guide.
- `database-failover.md`: database outage, exact off-host restore, and cleanup-confirmed DR proof response.
- `data-retention-delete-export.md`: privacy request, data export, account archive, and deletion runbook.
- `deployment-rollback.md`: deployment rollback response.
- `disposable-dev-server.md`: VM107 disposable dev-server rebuild and restore path.
- `high-cpu.md`: high CPU response.
- `high-error-rate.md`: high error-rate response.
- `incident-response.md`: cross-service incident ownership, severity, status communication, evidence, and closure contract.
- `mfa-encryption-key-rotation.md`: managed current/previous MFA key overlap, transactional re-encryption, and fail-closed old-key removal verification.
- `outbound-delivery.md`: transactional and staff-invitation email, notification outbox, tenant webhook replay, provider suppression, privacy erasure, and dead-letter response.
- `production-readiness.md`: public SaaS production launch preflight, required remote versioned Terraform state, immutable release, scheduled encrypted offsite backup, cleanup/absence-bound DR proof, alert, and post-deploy checks.
- `postgres-pitr-recovery.md`: off-host WAL/base-backup verification, isolated point-in-time restore, validation, promotion, cutover, and rollback procedure.
- `public-web-unavailable.md`: public DNS, TLS, Caddy, Next.js, release-header, and host-probe paging response.
- `security-incident.md`: security incident response.
- `service-level-objectives.md`: public web and API availability objectives, multi-window error-budget alerts, dashboards, response, and launch evidence.

## Current Focus

Use `disposable-dev-server.md` when VM107 needs to be replaced instead of repaired. It ties fresh-server bootstrap to GitHub, already-available data restore, `DEPLOYED_GIT_SHA`, and private-route validation.

Use `production-readiness.md` before public SaaS production deploys. It is the preferred `operator_runbook_url` for the Terraform production readiness gate and the release-manifest deploy gate.

Use `data-retention-delete-export.md` for account lifecycle, privacy export, tenant archive, and tenant deletion requests during beta.
