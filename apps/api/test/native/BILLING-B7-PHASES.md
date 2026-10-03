# B7 cross-owner meter-error fixture — worker and API phase source

These sources do not authorize native execution, installation, admission, CI
promotion or launch. Explicit local syntax/type checks require a separate caller. VM4014 is excluded entirely. VM107's
stopped/onboot/hook hold, VM218's disabled CI and unresolved QA34 storage
measurement incident remain governed by their owners. The existing launch
route and production stack are untouched.

This is an incomplete three-phase fixture. The API phase, its separate Vitest
configuration, an additional no-emit type configuration and the two worker
phases in one non-resumable owned session are authored. A durable phase-journal component and controller contract are now authored;
a callable coordinator now connects the worker/API/journal source through an
owner lease, but the trusted admission/process adapter and outer supervisor/
post-controller qualification path are not implemented.
Source review and syntax/type validation do not qualify native execution.
A passing API-only case or worker helper cannot qualify B7.

## Required future sequence

| Phase | Actual owner path | Required evidence |
| --- | --- | --- |
| Worker sends A | Actual selected PostgresUsageStore and StripeMeterClient, owner-admitted synthetic DB and no-egress transport | Real committed SENT/attempt1 at19:30:10; independently decoded first request; exactly one literal19:00–20:00 tuple, quantity3/nameA/customerA, original keys and submission; exact owned row/file handoff |
| API rotates once | Actual StripeMeterErrorService.handleWebhook and actual TenantPrismaService/Prisma; synthetic SDK signature result and bounded secureHttpRequest response | One correlated timestamp_in_future event gives matched1/transition1 at19:31; original payload/submission/tuple retained; both transport keys rotate with actual provenance; nextAttempt19:36; duplicate gives transition0 and identical whole stored row |
| Worker resends | Actual preparation/claim/client/mark_sent after committed count/customer/name B drift | Early preparation before19:36 cannot change A or send; retry at19:36:01 genuinely passes API backoff in same one-hour tuple; actual client emits A/newkeys/old timestamp, attempt2/SENT; exact owned cleanup and settled processes |

Set interval3600 before the initial A preparation and preserve it across every
phase. Never change a five-minute interval after row creation to hide the API's
five-minute retry. The main B1–B6/B8 suite stays separate at interval300.
SENT in this fixture acknowledges a bounded fake local response; it is not
Stripe acceptance, deduplication, aggregation or invoice proof.

The authored worker session verifies its exact source body, complete native
target receipt/migration/routine/RLS contract, independently establishes first
A bytes and persisted values, and returns bounded handoff bytes. The future
controller must publish those bytes through an exact owned private path. Do not create
a handoff by seeding an equivalent rotated row, invoking a private transition,
or supplying a prebuilt fake UsageEvent.

## Authored API source and configuration

Source paths:

- apps/api/test/native/billing-api-rotation.native.ts
- apps/api/vitest.billing-native.config.ts
- apps/api/tsconfig.billing-native.json
- apps/worker/tests/native/_billing_B7_worker_session.py
- apps/worker/tests/native/_billing_B7_phase_journal.py
- apps/worker/tests/native/_billing_B7_owned_driver.py
- apps/worker/tests/native/BILLING-B7-CONTROLLER.md

The existing unit configuration includes src/**/*.spec.ts and src/**/*.test.ts;
the new native filename/location is outside that discovery pattern. The new
native configuration is separate and never inherits the unit capability
fallback. It requires all three explicit phase paths, permits one worker,
disables file parallelism/retries/coverage, uses UTC and production mode, and
leaves ordinary build/pipeline configuration unchanged.

The original API compiler uses CommonJS. The additional no-emit configuration
supports import.meta with ESNext and includes the native fixture, its Vitest
configuration and current API source. It does not replace the ordinary
CommonJS production build/typecheck or establish loader/type compatibility.
Actual generated Prisma/TypeScript/Vitest/decorator/module/install behavior
remains unqualified.

The native case dynamically imports the actual handler and tenant database
service after source bindings. It injects a minimal synthetic signature SDK,
mocks the same secure-http-client export used by the handler, checks that
binding is a mock, and returns at most two small matching retrieval bodies.
No private transition method, ORM query-result mock or no-op context function
substitutes for actual handler/SQL ownership.

The current source pins are:

| Source | SHA256 |
| --- | --- |
| StripeMeterErrorService | 848a138658063007b237c7c48514523deb9190fcb26d63e7d38f1e397ab907fe |
| TenantPrismaService | 0a4a9040cf2b32de30552d2725c949c00b44816b51d83e230670e6f409ec37d1 |

Both paths must equal the actual source paths resolved from the fixture,
match the expected receipt hashes before import, and stay unchanged through
the phase. A composed overlapping edit requires a fresh reviewed selection;
these hashes must never silently qualify another body.

## Target and phase contracts — future owner-issued evidence

The protected receipt retains the worker target's existing exact disposable
job/role/database, expiry, source/schema/raw-ledger/routine pins and test-only
capability. It adds apiPhase fields databaseUrl, serviceSourcePath,
tenantSourcePath, serviceSha256 and tenantSha256. API databaseUrl is an explicit
password-bearing127.0.0.1 URL for the same database/role/port; its only
owner-supplied optional query parameter is sslmode. The fixture adds bounded
connection_limit/pool/connect/socket options and public schema.

The database owner must provision UTC, statement_timeout10s and lock_timeout5s
as this disposable role/database's defaults before admission, not by altering
shared settings. The API observes those actual settings, non-superuser/no
BYPASSRLS identity and actual ENABLE/FORCE RLS flags. The actual migrated
tenant/platform helpers execute through TenantPrismaService. Complete
migration/routine/policy validation remains the owner's separate obligation;
self-consistent JSON or table flags alone cannot qualify the schema.

The worker handoff is a regular non-symlink owner-private JSON file, at most
64KiB, containing:

- kind billing-B7-worker-sent-A and matching ownerJobId
- intervalSeconds3600, exact synthetic tenantId and usageEventId
- databaseIdentity with database, role, host and port from the actual admitted
  worker connection target, not a copied API URL; the API endpoint must match
- initialRow from actual persisted SQL observations, including the literal
  A payload, ACTIVE_STAFF metric, both transport identities, status/attempt,
  tuple and submittedAt
- independently verified first client capture/loaded-source evidence needed by
  the future final worker phase, excluding authorization/password/capability

TIMESTAMP3 observations must be normalized as UTC YYYY-MM-DDTHH:MM:SS.mmmZ,
retaining the actual driver timezone limitations. The literal start is
2026-07-09T19:00:00.000Z, end20:00, submittedAt19:30:10.

The API phase receives only explicit BILLING_NATIVE_TARGET_RECEIPT,
BILLING_NATIVE_WORKER_HANDOFF and BILLING_NATIVE_API_RESULT paths. No ambient
DATABASE_URL or real provider/SSO secret supplies its target. It uses fake
configuration/SDK values, validates the initial actual row against literal A,
freezes Date only, and leaves DB/network/runner timers real.

The synthetic event uses the correct configured meter, exact original
identifier/key, one explicit timestamp_in_future error and a bounded valid
window. Both actual handleWebhook invocations retrieve the matching synthetic
event. First rotation retains logical identity and payload, clears prior
result markers, and writes actual FAILED/backoff/provenance. Duplicate row
equality includes actual metadata/update timestamps; no Prisma engine clock
assumption supplies an expected updatedAt.

The API result is published only after successful assertions, client
disconnect and a final source-pin recheck. It records matching job/row/event
IDs, actual rotated row, counts and source pins, never receipt credentials or
retrieval headers. One active owner must hold the phase directory; the temp
write/recheck/rename sequence is not a general atomic no-clobber lock.
Failed disconnect publishes no success result. A monotonic25second gate is
checked before publication; fake Date cannot establish elapsed time. The file
still cannot authorize continuation: the future controller must require the
actual successful process exit plus source/result hashes and settled-resource
readbacks. Vitest timeout does not cancel arbitrary asynchronous work, and
synchronous file I/O/rename is not an absolute process-duration guarantee.
Actual backend termination,
absolute process/TCP deadlines and final resource readbacks remain required.


## Authored worker phase session — no runnable controller yet

The new "_billing_B7_worker_session.py" has no CLI, ordinary test discovery or
automatic child launch. One future admitted controller must keep a
B7WorkerSession context alive across start(), actual API child execution and
finish(). A new session requires an empty verified target; it cannot silently
resume retained rows. All loaded helper/session/API/config bodies must be
verified before import, in addition to the worker/helper readbacks in this
source. Readbacks after import are not install or loader provenance.

The context clears ambient environment, fixes interval3600 before initial
preparation, uses the real migrated non-superuser/FORCE-RLS target and selected
worker, and preserves exact seed ownership before SQL. start() calls actual
dispatch_usage, preparation/claim/client/mark_sent and reads the committed
SENT1 row. Its independent literal request oracle uses19:00 epoch1783623600,
quantity3/nameA/customerA and original transport keys. Its handoff carries
actual connection database/role/host/port properties and no credentials.

finish() receives bounded exact API-result bytes plus an observed zero exit
code. That argument is only a logical ordering precondition: this unfinished
helper cannot itself observe an API process, source/result file ownership or
settlement. The future controller must bind the actual owned child, exact
success exit, result/source hashes and terminal resources before calling it.
A zero supplied by a caller or a result file alone is never permission.

The helper rejects duplicate JSON keys, mismatched job/row/source/interval/
event/count bindings and a result that differs from the actual committed row.
It requires retained literal A, FAILED1/backoff19:36, rotated keys and exact
actual async provenance. It then commits count/customer/name B drift, observes
count4/customerB, and calls actual dispatch before backoff at19:31:10. The
actual preparation runs; no client call occurs and the whole row stays equal.
At19:36:01 actual dispatch prepares/claims/sends/marks SENT2. Literal A,
original19:00 timestamp and actual rotated keys must appear in the client
request; raw bytes may change only the identifier. Payload, tuple, creation
and async provenance remain unchanged.

The resend result explicitly says cleanupVerifiedfalse. It is only a phase
result until context exit succeeds. The context deletes exact registered
tenant rows and observes zero owned User/Usage/Tenant rows through fresh
actual connections before setting its in-memory cleanup_verified flag.
Failed setup/body/cleanup prevents session reuse; failed cleanup propagates.
A controller must retain original and cleanup failures and cannot publish a
terminal pass until cleanup and owner resource evidence are complete.

The session has a monotonic120second observation gate at phase boundaries.
It does not enforce an absolute process deadline, cancel SQL/executor work,
kill a child/backend, manage directories/files/locks, persist failures, or
prove no egress. Abrupt termination can prevent context cleanup. These remain
unimplemented controller and owner gates. This one paired worker source flow
is not added to the separate ten-method/21-scenario unittest count.


## Authored journal component — actual controller driver remains incomplete

The separate "_billing_B7_phase_journal.py" creates a fresh owner-private
canonical job directory exclusively, holds descriptor/lock identities and
one creator PID, serializes phase mutations and rejects stale directories or
phase retries. Its bounded assets preserve exact worker bytes; linked
immutable receipts retain source/result/target hashes, ordinal and previous
receipt hashes. FD-relative no-clobber link publication, fsync and readback
are authored, not native durability/locking evidence. Exact allocated temp
inode checks limit disposable cleanup; published artifacts are retained.

It records API-exit and cleanup observations supplied by the future driver.
It does not observe a child or database itself. Its sequence-complete file
explicitly remains nonterminal/native-unqualified and requires actual
controller exit plus external owner readbacks. Any body exception after
sequence completion appends a failure receipt; no sequence file can hide a
later error. Failure retains files and prohibits automatic retry/resume.

The detailed future driver sequence, owned directory/file contracts and
adversarial/native obligations are in "BILLING-B7-CONTROLLER.md". The authored callable coordinator
connects actual B7WorkerSession and journal phases through owner API-child
contracts, binds source/target/request/result/log/exit identity and queries
actual job-role backend observations after successful cleanup. Its trusted
owner authority/process adapter and outer terminal supervisor are absent;
caller JSON/protocol objects are not physical enforcement or native proof. This component has no
CLI, automatic execution, process kill, DB connection, native test credit,
admission authority or release qualification.

## Remaining qualification and ownership

Implement and independently qualify the trusted owner admission/process
adapter and outer supervisor around the authored coordinator/journal before
claiming the B7 source family complete. The worker
session intentionally cannot reattach to retained rows or retry after a phase
failure; recovery must preserve evidence and require owner terminal checks. Retain source/phase receipts and bound full logs. Missing admission
or handoff is failure, never a passing skipped case. Do not retry on a
timeout or reuse a stale job/database without owner terminal evidence.

The infrastructure owner must independently clear QA34, admit isolated
storage/32GiB job limits/fresh backing checks, enforce a finite overall job
deadline and prevent all provider/production/SSO egress. A module mock alone is
not network isolation. No Docker/image/VM/build/controller/worker loop/browser
session or external provider is authorized by this source guide.

Independent exact-source review, native type/loader tests, actual Prisma and
worker SQL behavior, API transition/resend/duplicate/deadline/cleanup evidence
and provider authenticity/effects are absent. This one synthetic positive
phase does not qualify all handler inputs, raw HTTP/controller/authentication
behavior, concurrent webhook races or the full system.

All84 workflows,47 browser surfaces,32 pipeline gates, real credentials/TOTP,
providers/devices/populated upgrade/restore and months of private testing
remain required. No production-ready or launch qualification is claimed.

## Approved existing-controller integration binding

This source selects the existing VM218 custom-ci integration target, with
database "lunchlineup_test" and restricted mutation role "lunchlineup_ci_app".
It does not request a new database, role, daemon, VM or alternate CI environment.
The infrastructure owner is Proxmox1 Manager; the accepted sole QA owner is
Fix settings and verify release. Acceptance of ownership is separate from
QA34 clearance and policy permission for this development fixture; release
candidate/signing promotion is a separate release gate.

The target receipt is version2 and cleanupOwnership is
"exact-controller-job-fixture-rows". Its controllerBinding has exactly
ciRunId, ciSourceSha, preflightPath and preflightSha256. ciRunId follows the
existing controller's160-character alphanumeric/dot/underscore/hyphen contract;
ciSourceSha is the actual40-lowercase-hex candidate revision. A billing32hex
ownerJobId is a separate one-shot fixture identity, not a CI run identifier.

The source requires the existing controller's protected pre-seed receipt at
"/var/lib/custom-ci/workspaces/<run>/.release/internal-ci/<sourceSha>/integration-target.json".
It binds the exact raw SHA and exact parsed existing receipt body:
runId, sourceSha, workspace, temporaryRoot, mutationRole,
dataTargetEnvironment "disposable", database, store and all three containers.
The store is "<RUNNER_TEMP>/lunchlineup-integration-containers-<run>";
container names use "lunchlineup-integration-<alphanumeric-run>-"
followed by postgres, redis and rabbitmq. RUNNER_TEMP is exactly
"/var/lib/custom-ci/runs/<run>/tmp/job-tmp".
The candidate build root is exactly
"<RUNNER_TEMP>/lunchlineup-source-<run>/build", including actual worker,
schema, API handler and tenant-service paths. DSN/URL host is exactly127.0.0.1,
with the actual controller-private mapped port and generated credentials.

Run integration fixtures only within an independently cleared exclusive
integration window after native migration and before any other suite seeds
Tenant/User/StripeUsageEvent. This fixture still requires their verified
empty starting state; it cannot adopt seeded data or truncate it. Cleanup
deletes only the exactly recorded fixture rows, never a database/role/store.
The worker handoff and actual API result bind the same four controller fields.

This receipt/hash/path binding cannot establish physical target ownership,
live port identity, capacity, no-egress or process settlement. The qualified
owner adapter must independently attest actual ci_run_id, ci_source_sha and
target_preflight_sha256 in its live lease and enforce exclusive access,
fresh parent/backing checks, the32GiB job limit and actual outer supervisor.
The coordinator checks those lease values before application imports and
binds controller metadata in child requests and local results. The artifact
parent must be canonical/private and within RUNNER_TEMP. Frozen existing
integration, target-check and storage-check scripts are source-pinned;
their current pipeline has no invocation of the B7 coordinator. Wiring,
actual owner/process implementations and post-controller qualification are
still absent. No runtime, qualification or new authority
results from this compatibility correction. Standalone version1 target
receipts and invented "ll_billing_fixture_" database/role names are rejected.

## Development admission and release promotion are separate

The accepted QA owner's September10 records distinguish disposable development
execution from release promotion. The user authorized resetting or recreating
dev-only runtime/database/synthetic fixtures, preserving unfinished source and
production. The approved development pipeline performed no release signing or
deployment; its focused historical result is source snapshot
"337db3c6f9e569fe2700950198b2c19e32a8b398", not this private source selection.
Its77 database tests,9 browser scenarios and12 helper tests do not verify
this candidate, this fixture or all84 workflows.

Development admission requires the applicable QA34 incident outcome, one
actual QA owner, fresh physical backing/capacity and approved bounded private
job/target/source/install provenance. It does not require production release
signing solely because it executes development tests. CI repository policy
must still authorize the specific admitted pipeline; the later QA34 closure
and disabled current policy supersede historical September10 enabled status.
There is no automatic admission or permission to enable that policy here.

Matching candidate/signing-policy promotion remains required for the release
pipeline and production-ready release; this separation removes no release
gate. VM107 launch/start hold and VM4014 production boundary remain unchanged.
An owner health snapshot, old development authorization or old focused green
run does not clear the subsequent QA34 measurement failure or prove fresh
capacity. Actual owner authority/process adapter, outer hard supervisor,
exclusive integration window and post-controller resources remain absent.
