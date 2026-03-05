# Runbook: Security Incident Response

## Severity Levels
- **P1 (Critical)**: Data breach, unauthorized access, credential compromise
- **P2 (High)**: Vulnerability actively exploited, suspicious admin activity
- **P3 (Medium)**: Vulnerability detected but not exploited

## Immediate Actions (P1)
1. **Contain**: Revoke all active sessions: `POST /api/cache/clear` via Control Plane
2. **Isolate**: If external breach suspected, block external network: `docker network disconnect external lunchlineup-proxy`
3. **Preserve evidence**: Snapshot all logs: `docker logs lunchlineup-api > incident-$(date +%s).log`
4. **Notify**: Alert team lead within 15 minutes.

## Investigation
1. Query audit log for suspicious actions:
   ```sql
   SELECT * FROM "AuditLog" WHERE action IN ('login', 'role_change', 'data_export')
   ORDER BY "createdAt" DESC LIMIT 100;
   ```
2. Check RBAC denial logs in Loki for permission escalation attempts.
3. Review Tempo traces for unusual API call patterns.

## Notification (GDPR)
- If personal data was exposed, notify affected users within **72 hours**.
- Document: what data was exposed, how many users affected, remediation steps taken.

## Post-Incident
1. Write post-mortem within 48 hours.
2. Update security controls to prevent recurrence.
3. Rotate all secrets: `./scripts/generate-secrets.sh --rotate`
