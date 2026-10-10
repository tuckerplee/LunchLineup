# Internal pilot data-handling checklist

Status: source reconciliation and proposed operating checklist, not approvals. No named human approver or verified contact has been supplied to this task. Product retention windows below describe the repository policy; they are not a determination of legal requirements. Public SaaS launch remains a separate decision.

## Before an internal pilot with real employee data

- [ ] Pilot sponsor identifies the organization, permitted employees, administrators, features and private access route. Record named owner and decision date; exclude integrations only by an explicit scope decision, not by calling an untested feature passed.
- [ ] Organization's HR/data owner authorizes employee-data use and access. Explain employee access/correction/deletion intake, who can see schedules/time/payroll, and where to report a problem. Confirm payroll policy timezone, period boundaries, break rules and independent approver. Payroll CSV/reconciliation is not wage calculation, tax filing or proof the payroll provider paid anyone.
- [ ] Organization administrator verifies actual least-privilege roles, tenant boundaries and separate settings, export, lifecycle, payroll read/export/approval permissions. A workspace export contains multiple employees' data; do not give it to a requesting employee as though it were a personal-data export. Use verified, scoped operator handling for individual requests.
- [ ] Privacy/support owner accepts a monitored private contact and protected intake queue, including coverage and escalation. For requests after loss of access or receipt expiry, verify requester identity/authority without restoring access or sharing capabilities. Record request reference, dates, export disposition, legal-hold review and response/closure evidence.
- [ ] Infrastructure/data custodian approves actual backup/log/artifact retention, access restrictions, restore proof and incident contact. The nominal windows below require operating evidence. No production timer is installed or launched by this checklist.
- [ ] King Push Test accepts the exact pilot candidate and missing workflow cases in `payroll-data-workflows-20261009.md`; preserve earlier native payroll proofs. Agent 5 supplies job/retry/cleanup and any included provider delivery evidence. No fabricated passes or certification.
- [ ] Pilot sponsor and application QA owner record go/no-go after these gates. This task does not lift VM107's stopped/launch hold or authorize production routes.

## Data behavior and control ownership

| Data/action | Current behavior to explain | Accountable role / unresolved evidence |
| --- | --- | --- |
| Organization/team settings | Organization name/timezone and team defaults are privileged settings. Ambiguous save uses readback and retained draft. | Organization administrator; King Push Test verifies browser/HTTP behavior. |
| Employee access | Tenant-scoped RBAC; own-user actions differ from team and platform powers. Deactivation/removal is not erasure of immutable employment history. | Organization HR/data owner approves assignments and offboarding; auth owner verifies credential revocation. |
| Account export | Requester-scoped expiring NDJSON artifact, explicit projections including payroll, excludes credentials/secrets/internal payloads; download requires current authority. | Organization administrator owns request and secure handling; Agent 5 owns artifact jobs/storage; Test owner verifies actual download and cleanup. Downloaded copies need an approved local retention/deletion policy. |
| Cancellation | Ends renewal at verified billing period close; does not start deletion clock or promise immediate access loss. | Organization account owner; Agent 5/provider owner supplies sandbox evidence. |
| Workspace deletion | Commits access barrier/session revocation, then billing cleanup. Pending receipt and finalized receipt both retain records under policy. Finalized is not physical erasure. | Organization authorized requester; privacy/support intake owner; platform administrator for retained-record purge. |
| Application retention | Repository policy: 30-day application-data stage; time cards require closed state, locked periods and current snapshots. Holds or failed preconditions prevent purge. | Data custodian must verify eligibility, successful execution and alerts; archived intake requires explicit deletion request rather than treating archive as deletion consent. |
| Retained payroll/financial/audit data | Repository policy: seven-year retained-record stage; final execution is reviewed platform-admin action, not automatic scheduler deletion. | Organization records/HR owner and legal reviewer confirm applicable policy; platform admin records execution proof. |
| Backups and logs | Repository targets: backups up to 35 days, application/security logs 90 days, subject to documented exceptions/holds. | Infrastructure custodian verifies installed policy and external expiry; database deletion cannot prove backup/log deletion. |
| Availability imports | Encrypted source envelope, terminal/cancellation erasure and bounded residual cleanup; parsed results and metadata have separate retention. | Agent 5 verifies worker/import cleanup. Reconcile the runbook's export description of a one-hour metadata window with its distinct 24-hour parsed-result cleanup and tenant-metadata retention before making external promises. |
| Notifications | User feed and read timestamps differ from outbound outbox/provider delivery. Terminal outboxes minimize payload/error data. | This task owns UI/read interaction; Agent 5 owns delivery, retry/dead-letter and provider evidence. |
| Lifecycle request records | Operation references persist in tenant settings and latest 20 are displayed; expiring deletion receipt supports revoked-session recovery. | Privacy/support owner must operate external protected cases beyond product receipt expiry/retention. Source implementation is not evidence of an operating request desk. |

Authoritative implementation references: `docs/compliance/privacy-security.md`, `docs/runbooks/data-retention-delete-export.md`, native settings/notifications/payroll services, retained account lifecycle services. Public copy and runbook wording must match observed deployment; do not silently change retention windows to clear a gate.

## Named outside approvals still needed

These name required approval functions, not invented people or completed decisions. Each needs a named human, dated decision and protected evidence reference.

| Approval | Internal pilot | Public SaaS / paid GA |
| --- | --- | --- |
| Pilot sponsor / organizational data owner | Approve scope, real employee-data use, private access and operational owner. Pending. | Reconfirm customer scope and operating model. |
| Employer HR/payroll records owner | Approve employee access, payroll policy and retention handling before real payroll use. Pending. | Confirm customer-facing responsibilities and payroll limitations. |
| Privacy/support operations owner | Monitored internal intake, identity verification, response/escalation and durable protected cases. Pending. | Approve published privacy/support/DPA contacts and staffing. |
| Infrastructure/data custodian | Backup/restore, retention enforcement, export storage/expiry, incident escalation. Pending actual deployment evidence. | Production scheduler/monitoring and external backup/log expiry evidence. |
| Legal counsel and authorized contracting signatory | Review applicable employee-data/organizational requirements where needed; a private pilot is not an exemption from applicable duties. No legal determination made here. | Approve contracting entity, Terms, DPA, signature process, incident-notice terms, subprocessors and any transfer terms before the applicable public/paid launch gate. None approved here. |
| Provider account owners | Supply approved sandbox configuration and recipient identities for included integrations; Agent 5 coordinates. Pending. | Approve production sender/provider accounts and qualifying delivery evidence. |
| Release authority | King Push Test's technical evidence plus explicit pilot launch approval. Pending. | Separate public/paid launch approval. No SOC 2 certification or compliance certification is claimed. |

Public pages currently consume `NEXT_PUBLIC_PRIVACY_CONTACT_EMAIL`, `NEXT_PUBLIC_SUPPORT_CONTACT_EMAIL` and `NEXT_PUBLIC_DPA_CONTACT_EMAIL`. Missing/invalid/template values show owner-signoff text; do not substitute invented addresses. A monitored internal contact may serve a private pilot only when the organization explicitly assigns it. Published SaaS commitments, DPA and paid-GA attestations are governed separately by `docs/compliance/dpa-readiness.md`; environment flags are not legal approval.

## Source-review handoff boundary

The export recovery follow-up changes only account UI request ownership and the settings identity key. It does not change retention, export projections, employee permissions, provider delivery or legal/contact approvals. King Push Test owns integration. The current instruction permits source/document review only, with no new tests or test/build/browser/runtime sessions. Outstanding checklist items remain pending, not waived.
