# Runbooks

## Files

- `README.md`: this runbooks folder guide.
- `database-failover.md`: database outage and restore response.
- `deployment-rollback.md`: deployment rollback response.
- `disposable-dev-server.md`: VM107 disposable dev-server rebuild and restore path.
- `high-cpu.md`: high CPU response.
- `high-error-rate.md`: high error-rate response.
- `security-incident.md`: security incident response.

## Current Focus

Use `disposable-dev-server.md` when VM107 needs to be replaced instead of repaired. It ties fresh-server bootstrap to GitHub, already-available data restore, `DEPLOYED_GIT_SHA`, and private-route validation.
