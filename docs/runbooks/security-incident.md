# Runbook: Security Incident Response

## Severity Levels

- **P1 Critical**: data breach, unauthorized access, credential compromise.
- **P2 High**: vulnerability actively exploited or suspicious admin activity.
- **P3 Medium**: vulnerability detected but not exploited.

## Immediate Actions For P1

1. **Contain**: revoke active sessions through the control plane or the database-backed session store.
2. **Isolate**: if external abuse is active, remove the proxy from the external network only after preserving enough evidence:

   ```bash
   docker compose \
     --project-name lunchlineup \
     --project-directory /opt/lunchlineup/current \
     --env-file /var/lib/lunchlineup/runtime-env/current \
     -f /opt/lunchlineup/current/docker-compose.yml \
     stop proxy
   ```

3. **Preserve evidence**:

   ```bash
   mkdir -p /var/tmp/lunchlineup-incident
   docker compose \
     --project-name lunchlineup \
     --project-directory /opt/lunchlineup/current \
     --env-file /var/lib/lunchlineup/runtime-env/current \
     -f /opt/lunchlineup/current/docker-compose.yml \
     logs --no-color api worker engine proxy > /var/tmp/lunchlineup-incident/app-logs.txt
   docker compose \
     --project-name lunchlineup \
     --project-directory /opt/lunchlineup/current \
     --env-file /var/lib/lunchlineup/runtime-env/current \
     -f /opt/lunchlineup/current/docker-compose.yml \
     ps > /var/tmp/lunchlineup-incident/compose-ps.txt
   cat /opt/lunchlineup/DEPLOYED_GIT_SHA > /var/tmp/lunchlineup-incident/deployed-git-sha.txt
   ```

4. **Notify**: page the production on-call route from Terraform `alert_targets` within 15 minutes.

## Investigation

Query audit logs for suspicious actions:

```sql
SELECT *
FROM "AuditLog"
WHERE action IN ('login', 'role_change', 'data_export')
ORDER BY "createdAt" DESC
LIMIT 100;
```

Then:

- Check RBAC denial logs in Loki for permission escalation attempts.
- Review Tempo traces for unusual API call patterns.
- Check proxy/API access logs for rejected Host, Origin, CORS, CSRF, and metrics-token failures.
- Review webhook delivery failures for SSRF blocks; do not paste full webhook URLs if they include credentials or token query parameters.
- Verify no `.env`, key, token, or backup payload has been committed to Git.
- Confirm current runtime SHA with `/opt/lunchlineup/DEPLOYED_GIT_SHA`.

## Notification

If personal data was exposed, document what data was exposed, how many users were affected, the exposure window, and the remediation steps. Route legal or customer notification decisions through the incident owner.

## Secret Rotation

Rotate secrets in the managed production backend named by Terraform `secrets_backend`. Do not rotate by committing plaintext files or copying `.env` between machines.

After rotation:

```bash
docker compose \
  --project-name lunchlineup \
  --project-directory /opt/lunchlineup/current \
  --env-file /var/lib/lunchlineup/runtime-env/current \
  -f /opt/lunchlineup/current/docker-compose.yml \
  up -d --force-recreate api worker control grafana
docker compose \
  --project-name lunchlineup \
  --project-directory /opt/lunchlineup/current \
  --env-file /var/lib/lunchlineup/runtime-env/current \
  -f /opt/lunchlineup/current/docker-compose.yml \
  ps
curl -fsS https://lunchlineup.com/health
```

## Post-Incident

1. Write a postmortem within 48 hours.
2. Update detection, tests, and runbooks for the failed control.
3. Confirm backups and audit logs remain intact after containment.
