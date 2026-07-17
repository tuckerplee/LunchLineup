# Runbook: Incident Response And Status Communication

## Severity

- **P0**: confirmed broad outage, destructive data loss, or active compromise affecting multiple tenants.
- **P1**: material customer workflow outage, rapid SLO burn, required dependency loss, or suspected unauthorized access.
- **P2**: degraded service with a workaround or persistent slow SLO burn.
- **P3**: contained defect with no current customer impact.

Security events also follow `security-incident.md`. Database recovery and release rollback use their dedicated runbooks.

## Roles

Every P0/P1 incident record must name one incident commander, one technical lead, and one communications owner. The incident commander owns severity, timeline, decisions, and closure. The communications owner publishes customer-safe updates and confirms delivery.

## Initial Response

1. Acknowledge P0/P1 paging within five minutes.
2. Open an incident record with a stable incident ID, UTC start time, affected services, current release SHA, alert links, and named roles.
3. Assess tenant scope without copying personal data, secrets, request bodies, webhook URLs, or raw query strings into the record.
4. Publish an investigating update within 15 minutes when customers are affected.
5. Choose mitigation, rollback, containment, or recovery from the linked service runbook.

## Status Communication Contract

Use the production status provider whose public health endpoint is `LUNCHLINEUP_STATUS_HEALTH_URL`.

Each external update must include:

- incident state: investigating, identified, monitoring, or resolved;
- affected customer capability and geographic or tenant scope only when safe;
- impact start time in UTC and the next update time;
- mitigation progress without internal credentials, hostnames, tenant identifiers, or speculative root cause.

Publish P0 updates at least every 15 minutes and P1 updates at least every 30 minutes until monitoring. Publish a resolved update only after customer-facing checks recover and the incident commander accepts the evidence.

If the status provider is unavailable, use the pre-approved secondary communication route and record that provider outage in the incident timeline. Social media or individual staff accounts are not an approved primary route.

## Evidence And Closure

Retain the page delivery/acknowledgement, status update identifiers, exact deployed SHA, relevant dashboard snapshots, command outputs with secrets removed, mitigation decision, recovery checks, and resolved notification. Record timestamps in UTC.

Closure requires:

1. customer-facing probes and required dependencies are healthy;
2. active fast-burn alerts are clear and slow-burn trends are recovering;
3. the paging route received a resolved notification;
4. the status page is resolved and its public health endpoint is reachable;
5. follow-up owners and deadlines are assigned.

Complete a P0/P1 postmortem within 48 hours. Track detection, runbook, test, and prevention changes to completion.
