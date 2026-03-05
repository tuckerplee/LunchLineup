# Runbook: Deployment Rollback

## Symptom
Production smoke tests fail after a deployment, or users report broken functionality.

## Automatic Rollback
The CI/CD pipeline (Stage 19) will auto-rollback if smoke tests fail.
Check GitHub Actions for the rollback status.

## Manual Rollback
```bash
# Roll back to previous image SHA
docker service update --rollback lunchlineup_api
docker service update --rollback lunchlineup_web
docker service update --rollback lunchlineup_engine

# If migrations need reverting
docker run --rm lunchlineup-migrations prisma migrate resolve --rolled-back MIGRATION_NAME
```

## Post-Rollback
1. Verify services are healthy: `curl https://api.lunchlineup.com/health`
2. Investigate root cause in Grafana/Loki.
3. File incident report.
