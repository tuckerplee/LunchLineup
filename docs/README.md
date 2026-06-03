# Documentation

## Files

- `README.md`: this documentation folder guide.
- `architecture.md`: platform architecture overview.
- `saas-ui-overhaul.md`: SaaS user-interface overhaul notes.
- `compliance/`: compliance documentation.
- `runbooks/`: operational runbooks, including the VM107 disposable-server restore path.
- `testing/`: testing and migration control documentation.

## Current Focus

Use `testing/README.md` for the migration testing baseline. It defines the parity workflows, SaaS behavior, hygiene behavior, and deploy-source checks that must stay green during the rebuild.

Use `runbooks/disposable-dev-server.md` when VM107 needs to be treated as replaceable infrastructure. It defines the 15-minute restore contract, GitHub-backed bootstrap path, existing-data restore input, and private-route validation checklist.
