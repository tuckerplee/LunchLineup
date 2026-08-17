# Custom CI

This directory defines source-neutral validation for LunchLineup on the internal CI appliance.

- `README.md` - documents this directory and its safety boundary.
- `pipeline.json` - declares triggers, worker requirements, validation steps, timeouts, and artifacts.

Source validation only. The declared `containers` capability is required for disposable validator and PostgreSQL fixtures. This pipeline never deploys, restarts, seeds, audits, or connects to the live LunchLineup service.
