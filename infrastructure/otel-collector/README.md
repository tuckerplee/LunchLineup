# OpenTelemetry Collector

## Files

- `README.md`: this collector configuration guide.
- `otel-collector-config.yml`: internal OTLP trace receiver with memory limits, batching, queued retries, and Tempo export.

## Runtime Boundary

The collector listens only on the internal Compose `telemetry` network. No OTLP, health, or collector metrics port is published on the host. Application services export OTLP/HTTP traces to the collector, which buffers short Tempo interruptions without putting observability on the request critical path.
