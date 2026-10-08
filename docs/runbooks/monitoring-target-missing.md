# Expected metrics target missing

`ExpectedScrapeTargetMissing` pages critical ops after two minutes without an
`up` series for an exact expected job and instance. `ServiceDown` covers a
present scrape target reporting `up=0`. A target removed from configuration, or
replaced by a different instance under the same job, must not silently become
healthy. `NativeApiMetricsMissing` remains the existing native job-level signal.

The expected inventory is the eight jobs in
`infrastructure/prometheus/prometheus.yml`: prometheus (`localhost:9090`), api
(`api:3000`), api-v2 (`api-v2:3002`), engine (`engine:8000`), worker
(`worker:3003`), webhook-replay (`webhook-replay:3004`), control (`control:3001`),
and node (`node-exporter:9100`). The source verifier binds the rule to these
exact job/instance pairs. Changes to deployment topology require coordinated
scrape configuration, expected-target contract, rule and qualification changes.

## Owner response

1. The runtime owner records the selected candidate, configuration digest,
   alert labels and first firing time in private evidence. Inspect the existing
   approved Prometheus target/configuration view and its rule evaluation health.
   Distinguish a missing target from a failed scrape; do not publish metrics
   tokens or scrape credentials in the incident record.
2. Compare loaded targets and configuration with the selected immutable source
   and runtime manifest. Check job removal, changed target/instance labels,
   failed configuration reload, and accidental selection of another candidate.
   A healthy same-job replacement does not prove the expected instance exists.
3. For a configured but failed target, follow its dependency/service runbook and
   capture the actual process, network, health and dependency result. Worker
   internals belong to Background Processing. Coordinate any source correction
   with King Push and any installed configuration change with the runtime owner.
   This runbook does not authorize a reload, restart, installation or probe of a
   protected target. VM107 stays stopped and held; VM4014/VM106 are excluded.
4. After an approved correction, the Test Agent verifies the exact instance
   returns, scrape success is real, candidate identity agrees, the missing alert
   resolves, and the resolved notification reaches the authorized monitored
   route. Preserve the failed attempt and recovery records. A loaded source
   rule or successful scrape alone does not close alert-delivery qualification.

Prometheus cannot report its own complete outage through a rule evaluated in
that same failed process. An independently monitored alert-delivery/watchdog
path and its authorized delivery proof remain required operational evidence.
No external route installation or delivery test is authorized by this change.

## Runtime inventory boundary

These eight scrape targets do not replace the 27-component service inventory in
`infrastructure/ci/internal-beta-runtime-services.json`. Readiness still requires
exact selected images/configuration, resource/network/attachment readbacks,
expected process ownership, fault/recovery and drain/cleanup evidence for every
applicable component. The four one-shots (migrate, backup, pitr-base-backup and
pitr-lifecycle-audit) need completion/effect and terminal cleanup proof, not an
always-running scrape. Other components use their declared health checks,
dependency telemetry and independent runtime readbacks. Keep missing runtime
proof pending; never infer a service pass from another service's metrics.
