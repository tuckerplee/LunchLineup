# Public Web Unavailable

## Trigger

Use this runbook for `PublicWebUnavailable` or `PublicWebProbeStale`. These alerts page when the bounded host probe sees a timeout, TLS/DNS failure, Caddy error such as `502`, wrong release, generic/non-HTML response, or when the probe stops publishing telemetry.

## Verify

1. Check the timer, last service result, and textfile metric:

   ```bash
   systemctl status lunchlineup-public-web-probe.timer lunchlineup-public-web-probe.service
   journalctl -u lunchlineup-public-web-probe.service -n 50 --no-pager
   cat /var/lib/node_exporter/textfile_collector/lunchlineup_public_web.prom
   ```

2. Re-run the bounded probe and inspect the canonical public route independently:

   ```bash
   systemctl start lunchlineup-public-web-probe.service
   curl --proto '=https' --tlsv1.2 --connect-timeout 5 --max-time 15 --max-redirs 0 -D /tmp/lunchlineup-public.headers -o /tmp/lunchlineup-public.html https://lunchlineup.com/
   cat /opt/lunchlineup/DEPLOYED_GIT_SHA
   grep -i '^X-LunchLineUp-Release:' /tmp/lunchlineup-public.headers
   ```

3. Check Caddy and web state without changing release truth:

   ```bash
   cd /opt/lunchlineup
   docker compose ps proxy web
   docker compose logs --tail=150 proxy web
   ```

## Recover

- For a Caddy `502` or hung web container, restore healthy `proxy` and `web` containers from the already verified release manifest. Do not write `DEPLOYED_GIT_SHA` manually.
- For a release-header mismatch, compare the running image, `/opt/lunchlineup/DEPLOYED_GIT_SHA`, and retained deploy proof before deciding whether to complete rollback or redeploy.
- For stale telemetry with a healthy public page, repair the systemd timer, collector directory permissions, or node-exporter textfile mount. Keep the alert active until two consecutive scheduled probes publish success.

## Close

Confirm the public response is `200` HTML, its release header equals `DEPLOYED_GIT_SHA`, the page contains LunchLineup and Next.js markers, `lunchlineup_public_web_probe_success` is `1`, and both paging alerts have resolved.
