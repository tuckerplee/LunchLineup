# Native billing payload fixtures — source and runtime contracts

Current disposition (2026-10-05): VM218 native infrastructure is cleared by the
installed owner runtime. The authoritative workspace handoff is
`notes/2026-10-05-native-runtime-owner-handoff.md`; it records 111 controller
tests, physical isolation, the real 180-second watchdog and automatic cleanup.
The installed controller is `8875c56e18b4b54b48ee3a745ab801399ba030dc` and its
admitted application source is `d18a1ad56dc7ad183d6ca535c00becf9376904de`.
These infrastructure results do not establish native B1–B8 application results.
The sole application QA owner remains task
`01a086de-26ad-7bd1-b933-60714401577d`, “Fix settings and verify release.”

This checkout composes the reviewed schema/helper pin correction with later
application repairs. It is a local candidate, not the installed source profile.
A newer candidate requires deliberate owner-selected authenticated source refs,
receive evidence, matching preparation inputs and fresh full preparation before
execution. Do not silently substitute this checkout into the existing starter.
Generic CI remains disabled; VM4014 is entirely excluded, and VM107 remains
stopped with its onboot/start-hook/launch hold intact. Source or target receipts
do not authorize source installation, provider access or application launch.
Fresh physical backing, parent capacity, enforced job limits and exclusive QA
ownership must still be verified at each admitted execution.

## Files

- `README.md`: source contracts, current clearance and qualification limits.
- `BILLING-B7-CONTROLLER.md`: lease, child-process and terminal owner protocol.
- `_billing_native_target.py`: validates explicit target identity, source pins, context routines and migration receipts before loading worker bytes.
- `billing_usage_stateful.py`: ten explicit native unittest methods covering 21 serial billing scenarios.
- `_billing_native_transactions.py`: actual connection ownership, commit gates, native lock observation and rollback probes.
- `_billing_B7_worker_session.py`: owns the initial and resend worker phases plus exact fixture-row cleanup.
- `_billing_B7_phase_journal.py`: publishes immutable phase artifacts in an exclusively owned private directory.
- `_billing_B7_owned_driver.py`: coordinates worker/API phases through required trusted owner leases and child receipts.

## Source selection and execution scope

"_billing_native_target.py" is the source path for the selected harness.
"billing_usage_stateful.py" is the source path for ten unittest methods
covering 21 serial scenarios. Its name deliberately avoids ordinary unit-test
discovery. It requires an explicit "--target-receipt" supplied by the admitted
native job. An absent or invalid receipt fails; no admission check is a skipped
green test. The ordinary pipeline policy is unchanged.

The worker is loaded only after target verification. The harness compares and
loads the exact selected worker bytes, not the frozen checkout's still-unfixed
body. The selected private worker body hash is
778283496621bf4694c7062f3ad6954b9aa5ac3243403c67ee084f6bcddc9729.
The current schema source hash is
08a4febaeffb80bd04b36b78bfd96881f14df0bd7d0c84b70c672a3ccb1ad20d.
A later overlapping edit or composed-source change requires a fresh reviewed
selection and corresponding fixture pins; do not silently accept another hash.

The actual PostgresUsageStore methods and SQL remain in use. The only process
clock replacement is a datetime-compatible UTC stage clock. Actual store
operations open independent Psycopg connections. Actual StripeMeterClient
builds the Request; a module-local urlopen replacement captures a strict safe
allowlist and returns bounded synthetic outcomes. It never contacts Stripe.
The fixture uses a synthetic client secret and ".invalid" API base.

No authorization headers, real provider secrets, arbitrary response bodies or
database DSNs belong in evidence. Persisted IDs/customer values are synthetic.
A supplied target receipt contains the test database password and test-only
platform capability; keep it owner-private, outside source control and reports.

## Target receipt and owner responsibilities

The receipt is an owner-issued, regular non-symlink JSON file, at most 64 KiB,
owned by the fixture process user with no group/other permissions. Its fields:

| Field | Required contract |
| --- | --- |
| kind / schemaVersion | lunchlineup-disposable-billing-target / integer2 |
| runtimeCleared | true, supported by separately inspected infrastructure clearance |
| cleanupOwnership | exact-controller-job-fixture-rows |
| ownerJobId | A unique 32-character lowercase hex job identity |
| controllerBinding | Exact ciRunId/ciSourceSha/preflightPath/preflightSha256, validated against existing controller pre-seed receipt |
| expiresAtUtc | A future aware UTC expiry, bounded by the admitted job |
| database / role | Exactly "lunchlineup_test" / "lunchlineup_ci_app", bound to the existing private integration job |
| dsn / port | Explicit test-only password, exact matching approved database/role/port, host127.0.0.1; no libpq service/options/multiple endpoints or ambient DATABASE_URL |
| platformCapability | Explicit test-only capability created for this disposable database; no production secret |
| workerSourcePath / workerSourceSha256 | Absolute admitted worker path and selected exact body hash |
| schemaSourcePath / schemaSourceSha256 | Absolute admitted schema source and selected exact source hash |
| rawMigrationReceipts | The complete independently reviewed native raw migration ledger, including path, sha256, bytes, phase, execution_mode and source_sha per row |
| routineSha256 | Owner-reviewed actual pg_get_functiondef SHA256 values for the four exact context signatures below |

The context signatures are public.set_current_tenant(text),
public.get_current_tenant(),
public.set_current_platform_admin(boolean,text) and
public.is_current_platform_admin().

The target must use the authoritative complete current schema and raw
migration/bootstrap process. Preserve actual historical checksums, reconciliation
receipts and ledger modes. Do not replace Tenant/User/StripeUsageEvent with a
simplified schema, install no-op context functions, copy a mock conflict
predicate, or call a self-consistent owner receipt proof of complete migrations.
Before admission, independently reconcile the receipt's entire inventory and
routine definitions to the approved candidate and actual bootstrap evidence.

The runtime role is non-superuser and has no BYPASSRLS. Actual Tenant, User and
StripeUsageEvent tables have ENABLE and FORCE RLS. Grant only the required
fixture DML/context functions and read-only ledger/catalog access to this
job's role. The harness installs no schema, capability, function, policy or
grant. Verification observes target identity, UTC sessions, role flags, RLS
flags, exact context routine hashes, exact ledger equality and initially empty
fixture tables. Those checks do not alone prove tenant policy semantics;
wrong-tenant/native RLS tests and owner review remain required.

One admitted process exclusively owns the initially empty approved integration target for the entire fixture window. The setup
connection seeds only synthetic rows through actual platform context; per-tenant
inspection/mutation uses actual tenant context. Register exact tenant ownership
before SQL, then clean only those IDs in finally: StripeUsageEvent, User, Tenant.
Do not use broad DELETE/TRUNCATE, drop any shared database or assume a wrapping
test rollback can clean operations committed on separate store connections.
If cleanup or executor settlement fails, stop and retain failure evidence;
do not launch a replacement job against the target.

All real store connections use explicit connect, statement, lock and idle
transaction timeouts and UTC session options. The future process runs TZ=UTC.
asyncio.wait_for is only an observation deadline and does not cancel a
to_thread SQL operation. asyncio.run executor settlement, exact cleanup,
a separately enforced finite whole-job deadline and terminal owner readbacks
are required before another job. No cancellation or absolute-duration claim
has been demonstrated by this source draft.

## Authored contracts and honest limits

| Family | Authored source | Independent oracle |
| --- | --- | --- |
| B1 same-interval unknown result | Four drift variants: count, customer, meter name, combined; real attempt at 19:30:10, early preparation at 19:30:20, real retry at 19:32:11 in the same 19:30–19:35 tuple | Literal first request fields/UTC epoch, committed FAILED/backoff state, exact early row immutability, retry byte/key equality and committed SENT attempt2 |
| B2 preparation matrix | Eight isolated persisted status/attempt/submission states; only never-claimed PENDING/0/null may refresh | Whole committed row before/after actual preparation; no mirrored predicate or SQL-result mock |
| B3 freshness | One never-claimed first-handoff case and one next-period case | First body contains new B values; next interval has distinct tuple/transport identities and literal timestamp, prior attempted row unchanged |
| B4 operator replay | Two serial outcomes: successful resend and repeat nonretryable rejection; disabled/misconfigured/too-young guards, actual requeue and replay-count cap | A payload/submission/logical tuple retained; both transport keys rotate with provenance; real worker resend emits A with new keys; success reaches SENT and rejection reaches capped DEAD_LETTERED |
| B5 explicit ID and wrong tenant | One serial timeout/drift/explicit-ID retry, with call-through preparation observer and wrong-tenant claim/read | Preparation call count0, no new other-tenant snapshot; context-only read by event ID returns no row under actual RLS; owner sends original bytes/key after real backoff |
| B6 finite retry-first sweep | Five job-private tenants, batch2, three actual cycles with counts2/2/1, exactly five successful captures | Due retry t05 precedes fresh t01; then t02/t03 and t04; one tuple per tenant, frozen retry A, current B meter name for fresh snapshots and no due rows afterward |
| B8 transaction interleavings and rollback | Three serial cases: held claim before refresh, held refresh before claim, controlled failure after actual upsert/claim before commit | PostgreSQL reports exact owned PID blocker through pg_stat_activity/pg_blocking_pids before gate release; MVCC reader sees prior committed A; committed handoff uses A or B according to real order; rollback preserves pending A, emits no request and permits a later real B handoff |

The seeded first count is exactly three: non-deleted STAFF, MANAGER and
suspended STAFF. The soft-deleted fourth user is excluded. Staff-count drift
adds one non-deleted user. This preserves the current implementation's count
definition rather than asserting a different billing policy.

The first captured A body is independently decoded to exactly five keys before
being used as a byte-equality oracle. The retry case advances the clock beyond
the actual two-minute backoff; it neither sleeps nor edits nextAttemptAt.
It should expose the frozen checkout's old FAILED-refresh behavior at the
early preparation step. Any immutable baseline negative-control execution
requires its own admitted source selection; the draft currently only accepts
the selected fixed-body hash.

The ten test methods / 21 serial scenarios are source contracts; native execution
remains unverified. No native SQL, driver, typing, RLS, provider acceptance,
deduplication, aggregation, invoice, complete exactly-once, storage isolation,
process deadline or release qualification follows from this file.

The five sweep IDs share the ownerJobId prefix and differ only in t01 through
t05. The fixture does not use random IDs to establish ordered tie-breaking.
The B6 oracle covers this finite backlog only; absolute retry priority can
starve new snapshots under continuous retry arrivals. It does not prove global
fairness, provider deduplication, or billing aggregation.

The B4 replay keeps the original literal period timestamp but intentionally
changes the identifier and HTTP idempotency key; compare payload fields rather
than full body equality across this transport rotation. Both successful resend
and rejection followed by replay-count exhaustion remain source-only controls.

## Transaction probe ownership and proof limits

"_billing_native_transactions.py" is the source path for the native
transaction probes. SQL text is classified only after real execute returns
to place a finite failpoint; no query/result/predicate is replaced. Real
Psycopg cursor/connection context managers perform commit, rollback and close.
A separate "at_exit" signal means the transaction has reached its actual
pre-commit gate; completed-statement signals alone do not establish that gate.

Claim-first holds the actual SENDING update before commit, commits source B
drift independently, observes B preparation waiting on that exact native
backend, then releases A. A later preparation must preserve attempted A.
Refresh-first holds actual pending B refresh before commit, observes claim
preparation waiting on that exact native backend, then releases B. The first
handoff must use B with the original logical tuple and transport identity.
The ordinary reader's full pre-transaction row must remain unchanged while
each gate holds. Actual returned claim objects go through the real client and
real mark_sent; no second claim or manufactured event supplies the body oracle.

Rollback raises one test-only error after real snapshot/claim SQL but before
the real context exit. Persisted state must equal prior pending A and the
capture list must stay empty. A normal later dispatch must refresh and send B
after rollback. A thrown synthetic error alone does not establish rollback;
only actual committed-row observations can satisfy that contract.

Each probe owns at most one actual connection. Ownership registers before
PID/setup validation. Two operation threads and one main inspection connection
are the maximum concurrent native connections in the interleaving. Use only
the admitted role's own activity/lock observations; the target owner must
review the required pg_stat_activity/pg_blocking_pids access, without granting
a shared-system or production inspection capability.

Commit gates expire after five seconds; native lock observation is bounded at
1.5 seconds after the waiting connection is established. The tests must fail
if the exact expected native lock was not observed. Thread waiting, a SQL-text
match, a fake row or a timeout is not a substitute. Native DSN timeouts can
expire first on a slow target; that is a failed fixture, never a passing
interleaving or permission to retry automatically.

Finally releases all owned gates, joins the operation executor, and requires
real connection close acknowledgments. Unopened operations do not require a
fictional exit. Failed settlement poisons the target for subsequent calls.
These source controls do not demonstrate absolute TCP/process bounds or
server-side session termination. The infrastructure owner's finite whole-job
deadline and actual terminal resource/cleanup readbacks remain mandatory.
No transaction, lock, rollback, close, thread or native result has
been executed or qualified in the current held phase.

## Required continuation — all eight original families stay in scope

B4 replay, B5 explicit-ID/wrong-tenant behavior and B6 finite retry-first sweep
now have source drafts. B8 now has source drafts for two directional interleavings and real rollback
using delegated actual connections. B7 now has a separate actual API-phase
draft plus two actual worker phases in one non-resumable owned session. A
durable phase-journal component and controller contract now have drafts; the
callable coordinator now has a draft; the trusted owner admission/process
adapter and outer supervisor/post-controller path are installed externally as
recorded in the October 5 infrastructure handoff. B7 application qualification
remains incomplete and unexecuted in the evidence for this source candidate. Do not substitute fake stores, simplified
SQL or seeded rotations for these owners.

B7 remains a separately authorized cross-owner extension: actual
StripeMeterErrorService.handleWebhook and TenantPrismaService against the same
disposable migrated database, synthetic SDK signature/retrieval seam, duplicate
transition control, provenance, rotated identities and actual later worker
resend. Configure its one-hour interval before initial preparation; do not
change the main fixture's interval to hide the five-minute API backoff.
A direct transition method or equivalent seeded FAILED row cannot qualify the
public API owner. Mocked SDK/retrieval still does not qualify Stripe authenticity.

The separate "_billing_B7_worker_session.py" has no CLI and does not add to the
ten-method/21-scenario suite. It returns bounded initial/resend phase bytes;
cleanupVerifiedfalse remains explicit until its owned context exits and
exact rows are verified empty. The admitted controller must own protected phase
paths, observe successful actual API child exit, verify exact source/result
hashes, enforce whole-job deadlines, retain failures and obtain terminal
resource evidence. See "BILLING-B7-PHASES.md" under apps/api/test/native.
No phase result, caller-supplied zero exit code or helper is runtime admission.

The separate "_billing_B7_phase_journal.py" owns only a fresh canonical private
directory, creator PID, flock and ordered immutable bounded phase assets/
receipts. It does not connect a database, observe/kill a process, enforce
whole-job limits or qualify caller observations. No-clobber publication and
failure retention are source-only; native filesystem/durability proof is
absent. Its sequence-complete receipt explicitly is not terminal and cannot
suppress a later body failure. The callable "_billing_B7_owned_driver.py" connects actual worker phases and
journal/API/cleanup bindings only through required trusted owner lease/child
contracts. It rechecks immutable input/source hashes, validates private
full-log/child receipts, prevents cleanup after uncertain API startup or
settlement, and queries actual job-role backend state after known cleanup.
The external installed owner supplies the admission/process adapter; the final
application qualification remains pending. No protocol or JSON field alone is
physical enforcement/native proof. See "BILLING-B7-CONTROLLER.md" here.
This new component does not change suite method/scenario or passing counts.

Before any passing claim: complete all remaining source fixtures, independent
exact-source review, loader/syntax/type checks and owner-admitted actual
execution with immutable full logs and settlement/cleanup evidence. Preserve
all84 application workflows,47 browser surfaces,32 pipeline gates, real
credential/TOTP/provider/device/upgrade/restore checks and months of private
testing as separate incomplete release requirements.

## Approved existing-controller integration binding

This source selects the existing VM218 custom-ci integration target, with
database "lunchlineup_test" and restricted mutation role "lunchlineup_ci_app".
It does not request a new database, role, daemon, VM or alternate CI environment.
The infrastructure owner is Proxmox1 Manager; the accepted sole QA owner is
Fix settings and verify release. Acceptance of ownership is separate from
the recorded October 5 infrastructure clearance and permission for this development fixture; release
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
their generic pipeline has no invocation of the B7 coordinator. The October 5
fixed owner runtime provides a separate admitted starter and process enforcement;
application execution and terminal qualification are still pending. No runtime,
qualification or new authority results from this compatibility correction. Standalone version1 target
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

Development admission requires the recorded infrastructure incident outcome, one
actual QA owner, fresh physical backing/capacity and approved bounded private
job/target/source/install provenance. It does not require production release
signing solely because it executes development tests. The fixed native owner admission applies to its exact reviewed source/profile;
generic CI policy remains disabled and supersedes historical September10 enabled status.
There is no automatic admission or permission to enable that policy here.

Matching candidate/signing-policy promotion remains required for the release
pipeline and production-ready release; this separation removes no release
gate. VM107 launch/start hold and VM4014 production boundary remain unchanged.
An owner health snapshot, old development authorization or old focused green
run does not prove fresh capacity or qualify this newer source candidate.
The installed owner supplies physical/process enforcement; exclusive application
execution, full native results and terminal resource receipts remain required.
