# Expected metrics target missing

`ExpectedScrapeTargetMissing` (in `docs/estate/lunchlineup-rules.yml`, evaluated by the estate Prometheus) pages critical ops after two minutes without an `up` series for an exact expected target. `ServiceDown` covers a present target reporting `up=0`. A target removed from the scrape configuration, or replaced by a different instance, must not silently become healthy. `NativeApiMetricsMissing` remains the native job-level signal.

The expected inventory is the `lunchlineup` scrape job in `docs/estate/lunchlineup-targets.yml`: `service` in `api`, `api-v2`, `engine`, `worker`, `webhook-replay` and `control`, all with instance `10.231.10.108:9180` (the token-protected metrics gateway on VM107), plus the host `node` series at `10.231.10.108:<port>`. Changes to the topology need coordinated changes to the targets file, the rules and their fixtures (`docs/estate/tests/`).

## Response

1. Open the estate Prometheus targets view and the rule evaluation health. Distinguish a missing target (no series) from a failed scrape (`up=0`). Never copy the metrics bearer token into an incident record; it is referenced only by the host file path in the scrape configuration.
2. Missing target: compare the estate scrape configuration with `docs/estate/lunchlineup-targets.yml` (job name, `__metrics_path__`, instance, `credentials_file` path). A healthy replacement under another instance does not satisfy the alert.
3. Failed scrape: from a host that may reach the VM, request the gateway path with the token read from the host file (`curl -fsS -H "Authorization: Bearer $(cat <token file>)" http://10.231.10.108:9180/metrics/<service>`). `401` means the estate copy of the token differs from the VM's `metrics_token`; `502` means the service behind the gateway is down (check `docker compose ps` on the VM and the service runbook); a connection failure means the proxy overlay is not publishing port 9180 or the estate route/firewall is closed.
4. After the correction, confirm the exact instance returns, the alert resolves, and the resolved notification arrives through the estate Alertmanager route.

## Boundaries

The scrape targets do not replace the component inventory in `infrastructure/ci/internal-beta-runtime-services.json`. One-shot components (`migrate`) need completion proof, not an always-running scrape. Prometheus cannot report its own outage; the estate's watchdog alerting covers that.
