# Pilot tenant provisioning (VM107 internal pilot)

Creates the first pilot organization on the private staging stack
(`https://dev.lunchlineup.com`, `DATA_TARGET_ENV=staging`, `NODE_ENV=production`)
with one idempotent command: tenant on a paid plan in `TRIAL`, the internal-beta
entitlement covering scheduling and lunch breaks, locations, an owner account and
employees with temporary PINs.

Script: `scripts/pilot/provision-pilot-tenant.mjs`. It needs only node and
`@prisma/client`, both of which the api-v2 image ships. No build, no `npm`, no
TypeScript and no node on the VM107 host.

This runbook does not start the stack or lift any launch hold. Use it only after
the stack is deliberately up and healthy (see `internal-beta-operations.md`).

## What the script refuses

It exits with code 2 before loading a database client unless all of these hold:

- `DATA_TARGET_ENV` is `staging`, `development`, `test` or `disposable`. `production`,
  `production-cutover`, any other value and unset all refuse. `NODE_ENV=production`
  is accepted only together with `DATA_TARGET_ENV=staging`.
- `APP_ENV`, `DEPLOY_ENV`, `NEXT_PUBLIC_APP_ENV` are not `production`.
- `DATABASE_URL` user, host and database name do not contain `prod` or `production`
  (same rule as `scripts/data-target-guard.mjs`); the connected `current_database()`
  is checked again inside the transaction.
- `APP_ORIGIN` is exactly `https://dev.lunchlineup.com` or `https://beta.lunchlineup.com`
  and `INTERNAL_BETA_ENTITLEMENTS_ENABLED=true`. Otherwise the grant would be inert.
- `PLATFORM_ADMIN_DB_CONTEXT_SECRET` is present (tenant creation runs in the
  platform-admin database context, as `TenantProvisioningService` does).

## Inputs

| Flag | Meaning |
| --- | --- |
| `--org-name`, `--org-slug` | Organization display name and natural key (`Tenant.slug`). |
| `--manager-email` | Owner account. Natural key `(tenant, email)`. |
| `--manager-role ADMIN\|MANAGER` | Default `ADMIN` (owner). `MANAGER` is enough for scheduling. |
| `--location "Name\|IANA_TZ[\|Address]"` | Repeatable. Natural key: name, case-insensitive. |
| `--employees-csv PATH` | See below. |
| `--pin-out PATH` | New file for temporary PINs. Required with `--apply` and a CSV. |
| `--plan` | `STARTER`, `GROWTH` (default) or `ENTERPRISE`. Must include scheduling and lunch breaks. |
| `--trial-days` | Default 30, at most 90. Used only when the tenant is created. |
| `--grant-credits` | Default 100, at most 1000. Seeds the usage-credit wallet. |
| `--grant-days` | Default equals the trial length; never beyond `trialEndsAt`. |
| `--grant-label` | Default `v1`. Use `v2` to renew an expired grant. |
| `--send-invite` | Also queue the standard invitation email for a new owner. |
| `--operator` | Name recorded in the audit trail. |
| `--apply` / `--dry-run` | Default is dry run. |

Employee CSV, header row required, UTF-8, quoted fields allowed:

```csv
name,email,phone,username,position,access_role
Ada Lovelace,ada@example.com,555-0100,,Cook,STAFF
Grace Hopper,,,ghopper,Server,
```

Only `name` is mandatory. `username` defaults to a name-derived `first.last`
(3 to 32 of `a-z 0-9 . _ -`); duplicates must be disambiguated with an explicit
`username`. `position` (or `role`) is stored as a scheduling skill, lowercased.
`access_role` is `STAFF` (default) or `MANAGER`. Employees sign in with
username and PIN; `email` and `phone` are stored as contact fields.

## Run it

The script is not in the image, so mount it read-only into a one-off container of
the existing api-v2 service. Run from the Compose project directory on VM107.

```bash
# One-time directories. uid 1000 is the image's "node" user.
install -d -m 0700 -o 1000 -g 1000 /var/lib/lunchlineup/pilot/out
install -d -m 0755 /var/lib/lunchlineup/pilot/in
install -m 0644 scripts/pilot/provision-pilot-tenant.mjs /var/lib/lunchlineup/pilot/provision-pilot-tenant.mjs
install -m 0644 staff.csv /var/lib/lunchlineup/pilot/in/staff.csv

# The api-v2 service does not carry these two variables; pass them explicitly.
# The secret is forwarded by name from this shell and never appears on a command line.
export PLATFORM_ADMIN_DB_CONTEXT_SECRET="$(sed -n 's/^PLATFORM_ADMIN_DB_CONTEXT_SECRET=//p' .env)"

pilot() {
  docker compose run --rm --no-deps \
    -e DATA_TARGET_ENV=staging \
    -e PLATFORM_ADMIN_DB_CONTEXT_SECRET \
    -v /var/lib/lunchlineup/pilot/provision-pilot-tenant.mjs:/pilot/provision-pilot-tenant.mjs:ro \
    -v /var/lib/lunchlineup/pilot/in:/pilot/in:ro \
    -v /var/lib/lunchlineup/pilot/out:/pilot/out \
    api-v2 node /pilot/provision-pilot-tenant.mjs \
    --org-name "Acme Pilot" --org-slug acme-pilot \
    --manager-email owner@example.com --operator "$USER" \
    --location "Main Cafe|America/Chicago|1 Main St" \
    --employees-csv /pilot/in/staff.csv "$@"
}

pilot                                              # 1. dry run, review the report
pilot --apply --pin-out /pilot/out/pins-20261020.csv   # 2. commit
```

If the secret cannot be read from `.env` this way (quoting), run the same command
against the `api` service instead: it already receives `DATA_TARGET_ENV` and
`PLATFORM_ADMIN_DB_CONTEXT_SECRET` from Compose, so drop both `-e` flags and replace
`api-v2` with `api`. `--send-invite` needs `api-v2` (its image carries
`dist/people/invitation-outbox.js`).

The script locates `@prisma/client` from the working directory, then `/app`; set
`PILOT_APP_ROOT=/app` if you override the working directory.

### Reading the result

The dry run executes the full write path (constraints, plan and capacity limits,
permission catalog check) inside a transaction that is always rolled back, then
prints a JSON report with per-entity `create` or `exists` and notes such as
`name differs; kept`. `--apply` runs the identical path and commits. Nothing is
printed that grants access: PINs are never written to stdout or stderr.

Collect the PIN file on the host, deliver each PIN to its employee out of band,
then shred it:

```bash
ls -l /var/lib/lunchlineup/pilot/out/pins-20261020.csv   # -rw------- 1 1000 1000
# ...distribute...
shred -u /var/lib/lunchlineup/pilot/out/pins-20261020.csv
```

Every PIN row is flagged `pin_reset_required=true` (`User.pinResetRequired`), so each
employee must choose a new PIN at first sign-in. The file is created with
`O_EXCL` and mode 0600 and the script refuses to overwrite an existing path.

## Owner sign-in

The owner has no password. Sign-in is the standard email one-time passcode at
`https://dev.lunchlineup.com`. `ADMIN` and `MANAGER` hold privileged permissions, so
the first sign-in walks through MFA enrollment (`mfaEnabled` starts false). With
`--send-invite` the usual staff-invitation email is queued through the existing
encrypted outbox and sent by the worker; without it, tell the owner to sign in with
the address. Invitations are never re-sent on a rerun.

## What gets written and why

| Record | Fields | Why |
| --- | --- | --- |
| `Tenant` | `planTier=GROWTH`, `status=TRIAL`, `trialEndsAt=now+30d`, `usageCredits=0` then grant, no Stripe ids | Paid plan, bounded trial. Same constraints as `TenantProvisioningService`: paid tenants are never created `ACTIVE` without Stripe or manual proof. |
| `TenantSetting internal_beta_entitlement` | `version 1`, `source internal_beta`, `status ACTIVE`, `features ['scheduling']`, `expiresAt <= trialEndsAt` | The gate in `apps/api-v2/src/platform/feature-entitlement.ts` accepts this only on an internal-beta origin with the flag on, for a paid-plan `TRIAL` tenant, and expands it to `INTERNAL_BETA_COVERED_FEATURES` (`scheduling`, `lunch_breaks`). The stored feature list stays `['scheduling']` by design; `time_cards` and payroll are not covered. |
| `CreditTransaction` | id `admin-credit-grant-<sha256>`, `amount` = credits, `balanceAfter` set | Scheduling and lunch-break writes debit one usage credit each; the gate also requires the immutable ledger row. |
| `AuditLog INTERNAL_BETA_ENTITLEMENT_GRANTED` | id `<grant>-internal-beta-audit`, `newValue.entitlement` | The gate cross-checks this row field by field. |
| `AuditLog TENANT_CREATED`, `PILOT_PROVISIONING_APPLIED` | counts only | Trace of who ran it. |
| `Role`, `RolePermission`, `RoleAssignment` | system `admin`/`manager`/`staff` roles, additive only | New tenants have no roles until something creates them. |
| `Location` | name, IANA timezone, address, `creationRequestKeyHash` | The hash makes `(tenant, name)` a database-enforced natural key. |
| `User` owner | `email`, `role`, no password, no PIN | Email OTP login. |
| `User` employees | `username`, `pinHash` (scrypt, same scheme as api-v2), `pinResetRequired=true` | PIN login with forced change. |
| `StaffSkill` | `position` | Scheduling skill used by the planner. |

The wallet is seeded with the grant credits only when the grant is created.

## Reruns, renewal and drift

- Everything is keyed on natural keys: tenant `slug`, location name, owner email,
  employee `username`. A rerun reports `exists` and writes nothing. It never changes
  an existing user's PIN or name, never reduces roles, and never switches plans.
- An existing tenant must be `TRIAL`, on the requested plan and not expired, else
  the run stops with an explanation.
- Existing employees are not in the PIN file (PINs are never recoverable). Reset a
  PIN through the application's staff PIN-reset action.
- The grant is fixed per `--grant-label`. After it expires, rerun with a new label
  (for example `--grant-label v2`) to issue a fresh grant and credits; the old ledger
  and audit rows stay. Expiry can never exceed `trialEndsAt` (extending the trial is
  a deliberate separate platform-admin action).
- New employees plus an unusable `--pin-out` path (already exists, directory not
  writable) abort the whole transaction: nothing is committed without its PIN file.

## Verifying

```bash
# Adjust the owner role and database name to this deployment's .env.
docker compose exec -T postgres psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -c \
 "SELECT slug,\"planTier\",status,\"trialEndsAt\",\"usageCredits\" FROM \"Tenant\" WHERE slug='acme-pilot'"
```

(The restricted application role is subject to row-level security and sees nothing
without a tenant context; use the owner role as above.) Then sign in as the owner and
create a draft schedule at the new location: a `403 scheduling_not_entitled` means the
grant, trial, `APP_ORIGIN` or `INTERNAL_BETA_ENTITLEMENTS_ENABLED` is wrong in the
running api-v2 container.

## Cleanup

There is no delete mode. A mistaken pilot tenant is removed through the platform-admin
tenant lifecycle (`data-retention-delete-export.md`), not by SQL.

## Tests

- `tests/hygiene/pilot-tenant-provisioning.test.mjs`: guards, CLI, CSV, PIN hashing
  and file mode, and drift checks against the entitlement gate, RBAC role
  definitions, internal-beta origins and the Dockerfile.
- `tests/integration/pilot-tenant-provisioning.test.mjs`: real PostgreSQL with the
  restricted role and the real api-v2 entitlement gate: dry run, apply, rerun,
  atomic PIN-file failure, and production refusals.
