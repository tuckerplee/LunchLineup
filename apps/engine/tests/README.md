# Engine Tests

Unit tests for the scheduling engine.

## Files

- `README.md`: this folder guide.
- `test_runtime_readiness.py`: verifies required gRPC bind/start readiness, the engine health contract, explicit empty availability, and inbound existing-weekly-minutes plus exact existing-shift protobuf mapping.
- `test_solver.py`: tests for typed default and custom-policy breaks, break-relief working coverage, solver feasibility, bounds, existing-plus-new weekly limits, cross-location existing-shift overlap exclusion, Monday calendar-week boundaries, explicit empty availability as unavailable, legacy direct-call omission behavior, DST/location timezone output, daily fallback demand, exact skill-qualified demand-window output, two-worker general/cashier overlap reuse, and independent overlapping skill coverage.
- `test_telemetry.py`: tests optional OTLP bootstrap, idempotent provider setup, exporter limits, shutdown registration, and W3C metadata extraction.
