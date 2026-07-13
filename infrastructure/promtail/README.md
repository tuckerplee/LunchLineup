# Promtail

## Files

- `README.md`: this log-shipping configuration guide.
- `promtail-config.yml`: Docker JSON log scraper with persistent positions, bounded retries, and Loki delivery.

## Runtime Boundary

Promtail reads the host Docker JSON log directory through a read-only bind mount. It does not receive the Docker control socket and publishes no host port. The positions file is kept in a named volume so restarts do not replay the full container log history.
