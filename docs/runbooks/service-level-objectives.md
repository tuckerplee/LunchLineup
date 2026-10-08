# Runbook: Service Level Objectives

## Current qualification scope

Keep legacy VM4014 entirely untouched until 2.0 has been fully tested for months. The next outcome is an isolated private qualification campaign. The VM107 launch hold and disabled VM218 admission remain authoritative; this document does not authorize runtime work, public probes, production access, deployment or cutover.

The native observability files are private source proposals until their exact selection is independently reviewed, integrated and qualified. A successful source check is not an operational SLO result.

## Availability objectives and ownership

The candidate retains the future 99.9% rolling 30-day objectives for public web probes and application responses. The public web objective covers one-minute probes of the canonical HTTPS application and expected release/rendering markers; its existing rules remain separate. No public probe may be run under the current scope.

The browser API response objective has one owner: completed responses at the native front door, selected by job="api-v2" and scope="application". Eligible classes are 2xx, 3xx, 5xx; 5xx is the failure numerator. This implements the existing documented exclusion of client errors. The previous retained denominator included 4xx; the new selector is an explicit source proposal requiring review.

Probe, metadata, operator, unmatched and metrics traffic are outside this response SLI. A delegated request contributes its final native response once; retained downstream metrics are diagnostic and must not be added to the same budget. Direct retained/provider ingress requires its own operational ownership rather than silently joining the browser budget.

A genuine quota denial is 429 and is excluded. Failed quota storage is service unavailability: the candidate must return 503, not synthesize a quota block. Ambiguous debit failures must not trigger a hidden EVAL retry or refund; the first charge remains when the second bucket fails.

Client disconnects and socket timeouts are separate fixed-reason abort counters. They do not receive fabricated completed 5xx responses. Process death, requests rejected before hooks, proxy failure, readiness and provider health require complementary private-runtime evidence. A completed-response SLI alone cannot prove every user action succeeded.

## Error budget and telemetry alerts

Paired native burn rules select only the native response family:

- Fast burn: five-minute and one-hour failure ratios both exceed 14.4 times the 0.001 error budget for two minutes.
- Slow burn: 30-minute and six-hour ratios both exceed 6 times the budget for 15 minutes.
- Positive eligible traffic is required in both windows. Raw denominators preserve sparse-traffic ratios; missing or zero traffic is unknown, not 100% availability.
- A missing5xx series has a query-side zero fallback only when actual eligible traffic exists.

ServiceDown includes the native job. NativeApiMetricsMissing detects a missing entire job; scaling needs an independently owned expected-target inventory. NativeApiHttpInstrumentationUnavailable pages when a successful scrape lacks a marker of1. HighNativeApiErrorRate uses the native eligible response ratio; HighNativeApiLatency uses seconds and a two-second threshold.

A successful /metrics scrape does not check dependencies. Native /v2/ready separately exercises database readiness and quota readiness; quota readiness already executes PING and the Lua protocol. Retained RequiredApiDependencyUnavailable covers retained database/Redis/RabbitMQ health. Neither gauge may be relabeled as the other's readiness. PublicWebProbeStale remains separate and critical.

The metric token is startup-cached, explicitly configured and read from the mounted secret. An unreadable or conflicting source must fail startup. Rotation requires a coordinated replacement of the admitted private candidate and scrape configuration with failed-scrape alarms observable; do not assume hot reload or simultaneous-token acceptance.

## Dashboard and historical qualification

Use LunchLineup Platform Overview, UID lunchlineup-platform, sourced from infrastructure/grafana/dashboards/platform-overview.json. Native rate/error/latency panels have native selectors and seconds-based latency. Retained diagnostic panels preserve their own namespace and units. Native telemetry and abort panels explain complementary gaps.

Native API Availability (30d, provisional) is a response-window estimate. Zero or missing eligible traffic yields no data; an instant stat with last-value reduction and Unknown fallback avoids displaying an earlier successful stat as current evidence. Grafana rendering and gap behavior still require native qualification.

A newly deployed series has no complete 30-day history. A current good scrape, partial increase result, counter-reset control, screenshot or dashboard threshold does not establish continuous historical coverage. Retain exact interval, collection/gap/reset/retention evidence, workload eligibility and independent query results before qualifying a rolling 30-day SLO. Months of private testing remain a separate required campaign; no history is backfilled or inferred.

Metric and trace labels must not contain raw unmatched paths, query strings, credentials, email addresses or customer-provided identifiers.

## Response after private runtime admission

1. Assign the incident and QA environment to their active owners and record the exact candidate, alert, start time and affected SLI.
2. Inspect the admitted private target and its scraper, marker, readiness, retained dependencies and final response classes. Do not read or probe VM4014 or VM106.
3. Separate genuine 429 quota denial, storage 503, missing telemetry and aborts before choosing mitigation. Retain fixed diagnostics without credentials or raw provider/driver payloads.
4. Use only the owned private rollback/recovery procedure after its prerequisites pass. The historical public launch commands are not the current execution path.
5. Close the private incident only after both alert windows recover, complementary health is current, and critical plus resolved alert-delivery receipts are retained.

## Required qualification evidence

Retain the exact source/tool/image selection and non-skipped results for native compile/type/loader checks, authenticated scrape/secret permissions, actual HTTP lifecycle and socket behavior, pinned promtool config/rule/fixture execution, Grafana provisioning/query/rendering and privacy.

Also retain critical and resolved Alertmanager delivery, approved private status-health routing, an owner-led recovery/incident drill, complete 30-day collection evidence and the full months-long acceptance campaign. Provider receipts, delivery acknowledgments, populated recovery and every application action require their own actual evidence. Source drafts and mocked cases cannot substitute.
