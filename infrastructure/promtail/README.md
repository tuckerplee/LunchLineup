# Promtail

## Files

- `README.md`: this log-shipping configuration guide.
- `promtail-config.yml`: OpenTelemetry Collector filelog pipeline with persistent offsets, bounded retries, and Loki OTLP delivery.

The Compose service name remains `promtail` to preserve operator scripts and volume continuity, but it runs the already-gated OpenTelemetry Collector distribution instead of the retired Promtail binary.

## Runtime Boundary

Promtail reads the host Docker JSON log directory through a read-only bind mount. It does not receive the Docker control socket and publishes no host port. The positions file is kept in a named volume so restarts do not replay the full container log history.
