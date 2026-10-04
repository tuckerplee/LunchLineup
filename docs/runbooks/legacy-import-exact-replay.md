# Legacy import exact-export replay

This is a prepared source contract. No real legacy export, database migration,
import, PostgreSQL recovery test or cutover has been qualified. VM4014 remains
untouched, VM106 is excluded, VM107 remains held, and protected native QA still
requires its owner and admission. Months of private qualification remain required.

The importer supports one approved, exact export per stable source namespace.
Its receipts identify companies, locations, users and staff independently of
mutable names, usernames or email addresses. A user and a staff row with the
same source ID remain separate identities. A replay preserves later application
edits, roles, credentials, account state, tenant policy and wallet state.

## Before a real import

The operator must establish the authentic source database lineage, approve a
real export against the explicit `legacy-combined-v1` adapter, review supported
password hashes and size limits, and approve an exact target generation. A file
hash proves which bytes were selected; it does not authenticate the source.
The checked-in synthetic fixtures do not establish a real exporter contract.

The selected private descriptor binds the source namespace, exact source SHA,
target generation UUID, adapter version, fixed role-plan SHA, canonical IANA
timezone, finite limits and explicit company-to-new-tenant slugs. Its independently reviewed SHA is required
before Prisma loads. The existing `DATA_TARGET_ENV` and database target guard
also applies. Production confirmation is a separate future cutover gate and
does not authorize any production action in this campaign.

The CLI requires an export path, `--descriptor <reviewed.json>` and
`--report <private.csv>`. `--report-only` performs read-only recovery after
admitting the same exact plan. Descriptor version 1 has exactly `schemaVersion`,
`namespace`, `targetGenerationId`, `sourceSha256`, `adapterVersion`,
`rolePlanSha256`, `timezone`, `companySlugs` and `limits`. Its fixed role digest
is exported by the pure planner. The supported credential adapter preserves
bcrypt `$2a$`, `$2b$` and `$2y$` hashes with cost 04–14; it rejects Argon2 and
other formats the retained password verifier does not support.

The limits object selects positive integer values no greater than the source
policy: 16 MiB input, 10,000 rows per array, 20,000 total rows, 2,048 code units
per ordinary input string, 100 username collision attempts, 10-second
transactions, 5-second transaction/lock waits and a 120-second CLI duration.
Smaller admitted limits can refuse otherwise valid input. Source/descriptor
reads are explicitly capped; the process deadline includes connection, execution,
report and disconnect. A synchronous stalled filesystem operation can defeat a
JavaScript timer, so the admitted job must also enforce its independent process
and session deadline. No timeout establishes rollback or session settlement.

The additive `20261004_legacy_import_retry_receipts.sql` migration creates an
operator-private `legacy_import` schema. Its generation UUID must match the
admitted descriptor. Import authority belongs to a reviewed privileged database
operator; the application role receives no private-schema access. Provisioning
the application role again must not change that boundary. A restored or cloned
database carries historical receipts; its owner must establish generation and
lineage policy before admitting an import. Do not delete receipts or select a
new namespace to work around a conflict.

An older import without exact account mappings cannot be adopted from its
username, email, login report, tenant slug or zero-credit provenance. Reconcile
it independently before a separately authorized change. Changed exports,
account merges, moves, deletions and synchronization require a separate policy;
the exact-export importer refuses them.

## Atomic progress and recovery

Fresh company initialization commits its Tenant, zero-credit provenance,
bootstrap roles and permissions, and company receipt together. The provenance
keeps the existing five-key zero-wallet/no-ledger ABI and grants no credits.
Existing global permission metadata is reused. Imported legacy super admins
become tenant ADMIN accounts; customer ADMIN excludes `admin_portal:access`.
Fresh Staff grants follow the canonical seed and exclude `lunch_breaks:write`.

Each fresh account commits its User, exact role assignment and entity receipt in
one bounded transaction. Each fresh location commits its location and receipt
together. Missing receipts permit create-only initialization; existing active
or deleted accounts are never adopted or overwritten by username. Username
allocation checks all rows within a finite collision budget. Email conflicts
require reconciliation. Pending account creation refuses drift in its recorded
bootstrap roles or permissions; completed replay leaves edited roles intact.

Receipt keys, source digests, target IDs and bindings are immutable. Minimal
identity tombstones have no foreign keys to application rows, so normal tenant
and account purges can proceed while exact replay cannot recreate a purged
target. The privacy owner must approve this minimal retention policy before a
real release. No credentials or mutable login usernames are stored in receipts.

Every replay validates its target generation and complete admission, exact row
receipts, actual target ownership and expected cardinality. A `COMPLETE` marker
does not bypass readback. Missing, purged or foreign targets fail closed.
An import error can leave earlier atomic rows committed. Do not infer rollback
from a timeout or lost acknowledgement: establish process and database-session
settlement, then explicitly resume the same approved plan. The importer does
not automatically retry arbitrary database errors or merge ambiguous state.

## Reports and qualification

Report recovery is read-only and uses the same admission. It reads current
scoped identity, labels current usernames and reports password-credential
presence without claiming the account can currently log in; no report is
adoption authority.
The destination must be an owned private directory. Publication uses an
exclusive private file, synchronization and atomic non-overwriting publication.
The opened directory must match the checked device/inode identity; publication
uses Linux procfs to retain that binding. Reports cap rows at 20,000, individual
UTF-8 cells at 8,192 bytes and total CSV output at 16 MiB. CSV cells escape
formulas. A report failure does not undo committed import
progress and must not cause another account creation. Preserve the primary
failure separately from any process, session, disconnect or report cleanup
failure.

Local planner and transaction-ledger fixtures exercise the actual JavaScript
owners over a controlled adapter. They do not execute PostgreSQL, its locks,
constraints, RLS, triggers, isolation, real process crashes or commit recovery.
An admitted native qualification must verify exact-schema repeat and concurrent
imports, precommit rollback and lost-acknowledgement restart, role/lifecycle
overlap, deleted-target tombstones, email/username conflicts, private-schema
access before and after application-role provisioning, bounded process/session
cleanup, and report permission/storage failures.

Logical backup currently selects all database schemas; restore omits original
owners and ACLs. The native recovery gate must independently prove receipt and
generation preservation, restored private-schema isolation, exact owned
catalog compatibility, and old-code/new-schema behavior. Raw migration rollback
policy, deployment contracts and release evidence must be reviewed on the final
candidate. A source commit or a passing fixture does not qualify these gates.
