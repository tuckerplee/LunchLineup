# Legacy PHP/MySQL to LunchLineup 2.0 migration

Operator procedure for carrying the existing customers' data from the legacy PHP/MySQL
application (`old/`) into the new PostgreSQL application at production cutover. It builds
on the exact-export importer described in `legacy-import-exact-replay.md` (identity
receipts, create-only replay, production confirmation gates); read that first.

Status: rehearsed only against a synthetic MariaDB 11.4 / MySQL 8.4 fixture generated from
`old/scripts/schema.sql` (`tests/fixtures/legacy-mysql-fixture.mjs`,
`tests/migration/legacy-mysql-roundtrip.integration.test.mjs`). No production host or
database was contacted. The first real run is a rehearsal on a scratch target; the numbers
in "Verify" must be reconciled by a person before the production run.

## Pipeline

```
production MySQL --(owner: consistent dump)--> dump.sql
dump.sql --> scratch MariaDB/MySQL (loopback only)
scratch DB --scripts/export-legacy-mysql.mjs--> export.json + descriptor.json   (legacy-combined-v2)
export.json + descriptor.json --scripts/import-legacy-users.mjs--> fresh migrated PostgreSQL
```

`legacy-combined-v1` (companies, stores, users, staff, two role tables) stays readable and
unchanged. `legacy-combined-v2` adds `shifts`, `break_templates`, `schedule_templates`,
`chores`, `settings` and `skipped_tables` (row counts of tables that are deliberately not
exported). A v2 descriptor sets `adapterVersion` to `legacy-combined-v2` and may add
`storeTimezones` and `scheduleTemplateCompanyIds`; v2 also raises the policy ceilings
(256 MiB input, 1,000,000 rows per array, 2,000,000 total, 30 s transactions, 1 h run).

## Owner decisions required before the production run

1. **Timezone per store.** The legacy schema has no timezone; shift and break strings are
   wall-clock text. The descriptor carries one default `timezone` and optional
   `storeTimezones` (`{"<legacyStoreId>": "<IANA>"}`). A wrong zone shifts every instant.
2. **Company slugs.** The exporter proposes `legacy-company-<id>`; the owner may edit the
   descriptor (the descriptor hash is then recomputed; the source hash is unaffected).
3. **Role mapping.** `super_admin`/`company_admin` -> ADMIN, `schedule` -> MANAGER,
   everything else -> STAFF. The legacy implicit `store` role is granted to every user, so v2
   does **not** treat it as a manager role (the v1 mapping did). Confirm.
4. **Shared schedule templates.** `schedule_templates` has no company column and may contain
   other customers' staff names. They are imported only into companies listed in
   `scheduleTemplateCompanyIds` (default: none, counted as skipped).
5. **Published state.** Legacy has no draft/publish concept; every imported schedule is
   `PUBLISHED` (`publishedAt` = week start). Confirm this is wanted, or archive past weeks.
6. **Locked/uncredentialed users.** Users whose hash is not supported are imported with no
   password and `pinResetRequired`; the owner must provide the outreach (invitation/reset)
   for them. Their count and reasons are in the plan summary.
7. **Freeze window.** The importer is create-only for one approved export per namespace. Data
   changed in the legacy app after the export is not carried; plan a read-only freeze of the
   legacy app (or accept a documented loss window) before the final dump.

## Steps

All commands run from the repository root of the release checkout. `<...>` values are
supplied by the operator; secrets are passed through environment variables only.

### 1. Dump (owner, on the legacy production MySQL)

```sh
mysqldump --single-transaction --quick --no-tablespaces --default-character-set=utf8mb4 \
  --result-file=legacy-YYYYMMDD.sql <legacy database>
```

Put the legacy app in maintenance first for the final dump. Separately and securely give the
operator the legacy `APP_KEY` (base64, from the legacy `.env`): it decrypts usernames and
staff names. Both are secrets; neither is committed or logged. Record the dump's SHA-256.

### 2. Load into a scratch database (loopback only)

```sh
docker run -d --name legacy-scratch -e MARIADB_ROOT_PASSWORD="$SCRATCH_ROOT" -e MARIADB_DATABASE=legacy \
  -p 127.0.0.1:3307:3306 mariadb@sha256:1292844148b311e4ed4300022a996d39083f415a963e970cf47cad1b3b18e3a6
docker exec -i legacy-scratch mariadb -uroot -p"$SCRATCH_ROOT" legacy < legacy-YYYYMMDD.sql
docker exec legacy-scratch mariadb -uroot -p"$SCRATCH_ROOT" -e \
  "CREATE USER 'll_export'@'%' IDENTIFIED BY '$EXPORT_PASSWORD'; GRANT SELECT ON legacy.* TO 'll_export'@'%';"
```

`mysql:8.4` works equally (same export bytes for the same data were observed on both). The
exporter refuses non-loopback hosts unless `LEGACY_EXPORT_ALLOW_REMOTE_HOST=scratch-copy-confirmed`;
do not point it at the production database.

### 3. Prepare the target

Apply all migrations to a fresh PostgreSQL with `node scripts/apply-db-migrations.mjs`
(production flow and confirmations as in `deployment-rollback.md`), take a verified backup,
and read the generation the descriptor must bind:

```sh
psql "$MIGRATION_DATABASE_URL" -Atc "SELECT generation_uuid FROM legacy_import.target_generation"
```

### 4. Export and create the descriptor

```sh
(cd scripts/legacy-export && npm ci)
LEGACY_MYSQL_PASSWORD="$EXPORT_PASSWORD" LEGACY_APP_KEY="$LEGACY_APP_KEY" \
node scripts/export-legacy-mysql.mjs --host 127.0.0.1 --port 3307 --user ll_export --database legacy \
  --out export.json --descriptor-out descriptor.json --namespace <acme-cutover-v1> \
  --target-generation <uuid from step 3> --timezone <America/Chicago> \
  [--store-timezone <legacyStoreId>=<IANA>]... [--schedule-template-company <legacyCompanyId>]...
```

The exporter runs one `REPEATABLE READ` / `READ ONLY` / `WITH CONSISTENT SNAPSHOT` transaction,
sends only `SELECT`, never overwrites its outputs (mode 0600) and prints counts only. It
aborts if a username does not match the stored `usernameHash` (wrong `APP_KEY`) or a staff name
still looks encrypted. Output: `sourceSha256`, row counts, `skippedTables`, descriptor hash.
Review `descriptor.json` (slugs, timezones, limits) and have a second person confirm both hashes.

### 5. Dry plan (no database connection)

```sh
DATA_TARGET_ENV=staging DATABASE_URL=<any non-production URL> \
LEGACY_IMPORT_DESCRIPTOR_SHA256=<descriptorSha256> LEGACY_SOURCE_EXPORT_SHA256=<sourceSha256> \
node scripts/import-legacy-users.mjs export.json --descriptor descriptor.json --plan-only
```

Prints the counts-only summary: schedules/shifts/breaks that will be created, shifts and
breaks skipped by reason, credentials preserved vs. forced to reset by reason, linked staff
accounts and the skipped tables. Review every non-zero "skipped" reason with the owner.

### 6. Import

Use the production target settings from `legacy-import-exact-replay.md`
(`DATA_TARGET_ENV=production-cutover`, `NODE_ENV=production`,
`LEGACY_IMPORT_PRODUCTION_CONFIRM=import-legacy-users-production-cutover`, both hashes,
migration-owner `DATABASE_URL`) and an owned `0700` report directory (Linux):

```sh
node scripts/import-legacy-users.mjs export.json --descriptor descriptor.json --report /private/dir/import-report.csv
```

Any failure leaves already-committed atomic steps in place. Do not infer rollback; resume with
exactly the same command (replay fills missing rows, never overwrites). `--report-only`
re-reads state without writing. A changed export needs a **new namespace on a new target**.

### 7. Verify (reconcile before opening the new site)

Use the SQL in `tests/migration/legacy-mysql-roundtrip.integration.test.mjs` as the model.
Minimum checks:

| Check | Expected |
| --- | --- |
| `Tenant` / `Location` | = legacy `companies` / `stores` |
| `User` | = legacy `users` + staff rows not linked to a user (`counts.staff` in the plan) |
| `Shift` | = legacy `shifts` - skipped (`shift_hours_unparseable`, `shift_date_invalid`, `shift_unknown_*`, `shift_exact_duplicate_dropped`) |
| `Break` | = legacy break entries - skipped break reasons |
| `Shift` with `userId IS NULL` | open shifts + `shift_overlap_unassigned` |
| `User.passwordHash` for a sample | byte-identical to legacy `password_hash`; sign in with a known test account |
| `User.pinResetRequired` count | = plan `credentials.pinResetRequired` |
| Sample shifts | UTC instants equal the legacy wall-clock in the store timezone (check one before and one after a DST change); breaks inside the shift |
| `report.data.companies[*].present` vs `planned` | equal immediately after import |

### 8. Abort / rollback

Before cutover, restore the pre-import backup and discard the namespace (a fresh target
generation is required for a new attempt; receipts are never edited or deleted). After
cutover keep the legacy database read-only and unchanged for the agreed retention period.
Neither this tooling nor the importer reverses a completed import.

## Mapping

| Legacy | LunchLineup 2.0 |
| --- | --- |
| `companies` | `Tenant` (slug from descriptor, ENTERPRISE, zero credits) + bootstrap roles |
| `stores` | `Location` (timezone from descriptor, `storeTimezones` override) |
| `users` (+ same-id `staff` row for staff-role/admin users) | one `User` (username/email from the decrypted login, display name from the staff row, `passwordHash` kept) |
| `staff` without a linked user | `User` (STAFF, no credential; ADMIN if `is_admin`) |
| `user_company_roles` / `user_store_roles` | `User.role` + matching `RoleAssignment`; per-store access scoping is not represented (new users are tenant-wide) |
| `shifts` | `Schedule` per location and local Monday-to-Monday week (`PUBLISHED`), `Shift` (role = `pos`; notes = tasks and sign-off) |
| `shifts.breaks` JSON, else `break1`/`lunch`/`break2` columns | `Break` rows typed `BREAK1`, `LUNCH`, `BREAK2` by legacy slot; LUNCH unpaid, others paid |
| `staff.pos` | `StaffSkill` |
| `staff.lunch_duration`, `staff.tasks` | `legacy.staff_profiles.v1` tenant setting |
| `settings` (global/company/store) | `legacy.settings.v1` tenant setting (store keys resolved to new Location ids) |
| `break_templates` | `legacy.break_templates.v1` (offsets are hours after shift start, durations minutes); the company-less default is copied to every tenant |
| `schedule_templates` | `legacy.schedule_templates.v1` only for `scheduleTemplateCompanyIds` |
| `chores` | `legacy.chores.v1` (assignees and creators resolved to new User ids) |

Preserved configuration documents have no consumer in 2.0 yet: they keep the data safe for a
later feature and for reference; they do not change scheduling behaviour. A provenance document
`legacy-import.data-provenance.v2` records the source hash and the counts-only summary.

Times: `shift_hours` ("9:00 AM-5:00 PM", also 24-hour and "9a-5p" variants) is interpreted in the
store's IANA zone; an end at or before the start is an overnight shift ending the next day.
Break clock times earlier than the shift start fall on the next calendar day. A time inside a
spring-forward gap resolves forward; an ambiguous fall-back time resolves to one fixed instant.

Quality rules (each counted by reason, never silently): unparseable hours/dates skip the shift;
an exact duplicate (same person, store and window) is dropped; any other overlap for the same
person keeps the shift **unassigned** with an explanatory note (same remedy as
`pre_20260717_legacy_shift_overlap_unassign.sql`); a break outside its shift, overlapping an
earlier break, with an unparseable time or a non-positive duration, or beyond the third slot, is
dropped.

Passwords: bcrypt (`$2a$`/`$2b$`/`$2y$`, cost 04-14, the format PHP `password_hash` writes) is kept
unchanged and verifies with the new login. Anything else (empty, other bcrypt variants or cost,
Argon2, unsalted digests, unknown) yields an account with no password and `pinResetRequired`.
The plan summary lists counts per reason only.

Idempotency: every Schedule/Shift/Break/StaffSkill/TenantSetting id is derived from
(namespace, tenant, kind, legacy key). Until the run is `COMPLETE`, replay creates only missing
rows; afterwards nothing is recreated, so later edits and deletions in the new app are preserved.

## Not migrated

| Item | Reason |
| --- | --- |
| `audit_logs`, `login_attempts`, `mail_queue`, `password_resets` | operational history/state of the old app; counts are recorded in `skipped_tables`. Pending invitations and reset tokens must be reissued in 2.0 |
| `roles`, `role_permissions`, custom role names | 2.0 uses a fixed role plan; unknown role names are counted (`unknownRoleAssociations`) and ignored |
| `users.locked_until`, `created_at`/`updated_at` | stale or not meaningful in the new model |
| Chore pivot tables (`chore_*_positions`, `chore_required_skills`) | not part of the base schema; chores keep their own columns only |
| Per-store user membership and `home_store_id` | no equivalent: 2.0 users are tenant-wide |
| Sessions, JWT secrets, backups, `public/backups` | operational artifacts |
| Billing/credits | none existed; wallet stays zero as in the exact-export importer |

## Rehearsal

```sh
(cd scripts/legacy-export && npm ci)
node --test --test-concurrency=1 tests/migration/legacy-import-v2-plan.test.mjs tests/migration/legacy-mysql-roundtrip.integration.test.mjs
LEGACY_ROUNDTRIP_MYSQL_IMAGE=mysql:8.4 node --test tests/migration/legacy-mysql-roundtrip.integration.test.mjs   # MySQL variant
```

The round trip uses unique `ll-legacy-mariadb-*` / `ll-legacy-pg-*` containers and removes them.
Report publication needs Linux procfs; the CLI `--report` path was exercised under WSL Ubuntu, not
in the automated test.
