# Runbooks

## Files

- `README.md`: this runbooks folder guide.
- `2.0-action-acceptance.json`: pending per-action acceptance contracts, source anchors, proposed scenarios and reviewed browser selections; not executed acceptance.
- `2.0-action-acceptance.md`: full-surface acceptance evidence rules and source inventory limitations for isolated qualification.
- `legacy-import-exact-replay.md`: prepared exact-export import identity, durable receipt, retry/recovery and read-only report contracts.
- `legacy-migration.md`: operator steps for the real legacy PHP/MySQL cutover (scratch load, export, descriptor, import, verification, rollback) and the explicit list of what is and is not migrated.
- `mfa-durable-enrollment-rollout.md`: prepared durable MFA enrollment generation, expiry, migration and future rollout qualification contract.
- `database-failover.md`: database outage, exact off-host restore, and cleanup-confirmed DR proof response.
- `data-retention-delete-export.md`: privacy request, data export, account archive, and deletion runbook.
- `deployment-rollback.md`: deployment rollback response.
- `disposable-dev-server.md`: VM107 disposable dev-server rebuild and restore path.
- `high-cpu.md`: high CPU response.
- `high-error-rate.md`: high error-rate response.
- `incident-response.md`: cross-service incident ownership, severity, status communication, evidence, and closure contract.
- `internal-beta-operations.md`: VM107 exact-candidate launch, verification, encrypted restore drill, resource-saving pause/resume, and fail-closed readiness contract.
- `pilot-tenant-provisioning.md`: idempotent dry-run-first provisioning of the VM107 pilot tenant (paid-plan TRIAL, internal-beta grant, locations, owner, employees with temporary PINs) from the api-v2 image.
- `internal-beta-hands-on-signoff.md`: exact-SHA automated interaction-evidence boundary and independent unfamiliar-evaluator Calendar, touch, Lunch, and Time Cards checklist.
- `mfa-encryption-key-rotation.md`: managed current/previous MFA key overlap, transactional re-encryption, and fail-closed old-key removal verification.
- `outbound-delivery.md`: transactional and staff-invitation email, notification outbox, tenant webhook replay, provider suppression, privacy erasure, and dead-letter response.
- `production-cutover.md`: current plan for replacing the legacy PHP app at lunchlineup.com: `deploy-release.sh --target production` path, rehearsal, cutover steps, go/no-go criteria and rollback (supersedes the VM217/Sigstore runbooks).
- `production-readiness.md`: public SaaS production launch preflight, required remote versioned Terraform state, immutable release, scheduled encrypted offsite backup, cleanup/absence-bound DR proof, alert, and post-deploy checks.
- `postgres-pitr-recovery.md`: estate pgBackRest point-in-time recovery contract, the application WAL-archive hook, and the application-side restore steps.
- `security-incident.md`: security incident response.
- `service-level-objectives.md`: public web and API availability objectives, multi-window error-budget alerts, dashboards, response, and launch evidence.

## Current Focus

Use `disposable-dev-server.md` when VM107 needs to be replaced instead of repaired. It ties fresh-server bootstrap to GitHub, already-available data restore, `DEPLOYED_GIT_SHA`, and private-route validation.

Use `internal-beta-operations.md` to turn the intentionally offline VM107 beta into a candidate-bound session, prove direct/public behavior plus delivery/monitoring/restore readiness, and pause it again without changing `onboot: 0` or deleting data.

Use `production-cutover.md` for the current production deploy and cutover (the VM217/Sigstore documents below it are superseded). Historical: use `production-readiness.md` before public SaaS production deploys. It is the preferred `operator_runbook_url` for the Terraform production readiness gate and the release-manifest deploy gate.

Use `data-retention-delete-export.md` for account lifecycle, privacy export, tenant archive, and tenant deletion requests during beta.

- `production-qualification-bridge.md`: scoped application repair or disposable qualification support.

- `2.0-validation-plan.md` - defines isolated testing over months while production stays untouched.
- `2.0-workflow-acceptance.md` - tracks all 84 current-candidate workflow acceptance dispositions.
