# Solver

Constraint-solver implementation for generated staff schedules.

## Files

- `README.md`: this folder guide.
- `logic.py`: bounded CP-SAT solver with location-local Monday-to-Sunday calendar weeks and DST-safe UTC boundaries, tenant-wide existing-plus-new weekly minute limits, exact existing-shift overlap exclusion, UTC output, boundary-segmented overlapping demand windows, general/per-skill maximum coverage matching publish policy, explicit empty per-employee availability as unavailable, typed default `BREAK1`/`LUNCH`/`BREAK2` policy, custom break-rule thresholds and durations, break-relief demand, staggered breaks, and post-solve working-coverage validation.
