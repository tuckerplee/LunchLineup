# SOC 2 Type 1 Readiness: LunchLineup

This is a source-backed readiness inventory, not a completed control assessment or a certification claim. It retains the Security criteria and control topics previously listed here; it is not a complete Trust Services Criteria mapping. Implementation evidence below identifies code or documentation, not proof that a deployed control is operating as intended.

Current operating boundary: generic LunchLineup CI remains disabled, and full runtime/release qualification is incomplete. Disposable component runs do not establish a full release pass or production operation. [GitHub Actions is disabled](../../.github/workflows/README.md); the [internal pipeline definitions](../../.ci/README.md) describe configured gates, not evidence of an active or successful run. Production and VM107 launch holds remain unchanged. No owner, approval date or audit result is inferred from a checked-in file.

## Trust Services Criteria: Security

### CC1.0: Control Environment

| Control topic | Implementation or documentation evidence | Evidence still required |
| --- | --- | --- |
| Security policies defined and communicated | [Privacy/security commitments](privacy-security.md) and [incident-response responsibilities](../runbooks/incident-response.md) are documented. | Approved policy versions, communication/training records and acknowledgements. Document existence does not establish approval or communication. |
| Employee background checks | No completed personnel-screening evidence is established by this source review. | Applicable screening policy and authorized personnel records; keep private records outside this repository. |
| Roles and responsibilities | Application [role/permission definitions](../../apps/api/src/auth/rbac.service.ts) and incident roles are implemented/documented. | Named organizational control owners, separation of duties, access-review records and joiner/mover/leaver evidence. Application RBAC is not an organizational responsibility assignment. |

### CC6.0: Logical and Physical Access Controls

| Control topic | Implementation evidence | Evidence still required |
| --- | --- | --- |
| Multi-tenant database isolation | [RLS hardening migrations](../../packages/db/prisma/migrations/rls_relation_hardening.sql) and the [API-v2 tenant transaction helper](../../apps/api-v2/src/platform/database.ts) define isolation controls. | Exact deployed migrations, runtime roles without unintended bypass privileges, and cross-tenant negative results against the deployed configuration. |
| Administrative MFA | [Shared MFA policy](../../packages/rbac/mfa-session.ts), [current mutation authority](../../apps/api-v2/src/people/mutation-authority.ts) and the [durable enrollment rollout runbook](../runbooks/mfa-durable-enrollment-rollout.md) provide implementation evidence. | Deployed enrollment/enforcement/recovery evidence, approved exceptions and administrator enrollment records. Source implementation is not universal enrollment proof. |
| Session management | [Auth controller](../../apps/api/src/auth/auth.controller.ts) sets HttpOnly access/refresh cookies, SameSite and configurable Secure attributes. The CSRF cookie is deliberately script-readable. | Actual HTTPS/cookie configuration, expiry/revocation/logout results and operational session policy. Do not infer Secure=true from source defaults alone. |
| RBAC enforcement | [API guard](../../apps/api/src/auth/rbac.guard.ts), [API-v2 permission checks](../../apps/api-v2/src/platform/identity.ts) and [transactional People authorization](../../apps/api-v2/src/people/access.ts) enforce permission-based decisions. | Deployed least-privilege and escalation-denial evidence plus periodic access reviews. The [shared package exports Casbin](../../packages/rbac/index.ts), but these inspected guards use permission sets; this inventory does not claim universal Casbin enforcement. |

Physical access and infrastructure administrator controls require separate host/provider access and review evidence; application authorization does not establish them.

### CC7.0: System Operations

| Control topic | Implementation or documentation evidence | Evidence still required |
| --- | --- | --- |
| Centralized logging and monitoring | [Loki configuration](../../infrastructure/loki/loki-config.yml) and [Grafana provisioning/dashboards](../../infrastructure/grafana/README.md) are checked in. | Deployed ingestion, retention/access controls, alert delivery and response evidence. Configuration files do not establish active monitoring. |
| Vulnerability scanning | [Internal pipeline](../../.ci/pipeline.json) declares Semgrep, CodeQL and Trivy stages. | Candidate-bound scan results, triage/remediation records and evidence of recurring execution. Generic CI being disabled prevents claiming an active continuous scanning control. |
| Incident response | [Security incident](../runbooks/security-incident.md) and [incident/status communication](../runbooks/incident-response.md) runbooks exist. | Approved contacts, assigned responders, exercises and incident records showing response and closure. |
| Sensitive-action audit logging | [Audit table/trigger reconciliation](../../packages/db/prisma/migrations/20260712_core_rls_audit_forward_reconciliation.sql) and [authorized retention/redaction functions](../../packages/db/prisma/migrations/20260713_audit_log_retention_authorization.sql) define protected audit records. | Deployed grants/triggers, sensitive-action coverage, denied tampering and controlled retention evidence. Authorized redaction/purge exceptions mean this is not an unconditional immutability claim. |

### CC8.0: Change Management

| Control topic | Implementation or documentation evidence | Evidence still required |
| --- | --- | --- |
| Automated test/security gates | [Pipeline](../../.ci/pipeline.json) and [external receipt-signing policy](../../infrastructure/custom-ci/lunchlineup-internal-beta.policy.json) define release gates. | Authorized pipeline activation and complete candidate-bound gate/signature evidence, reviewed changes and applicable [human interaction signoff](../runbooks/internal-beta-hands-on-signoff.md). Failed, skipped or unexecuted gates remain unresolved; component passes do not satisfy the full release gate. |
| Reproducible infrastructure | [Production Terraform](../../infrastructure/terraform/production/README.md) defines infrastructure inputs and a readiness gate. | Approved real configuration, reviewed plan/apply records, state protection, access controls and drift evidence. Checked-in IaC or mocked-provider checks do not establish deployment. |

Before marking any control complete, retain the exact scope/environment, implementation revision, evidence location, observed result, exceptions and actual reviewer approval. Unverified operational and human controls remain pending until that evidence exists. This documentation change enables no CI policy, deployment or application launch.
