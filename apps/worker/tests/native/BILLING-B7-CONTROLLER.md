# B7 controller contract — journal and coordinator source

The journal and callable coordinator are source components; their native
sequence is unexecuted. The coordinator connects the actual worker session,
API-result/exit bindings and cleanup observations through an owner runtime
lease. The trusted admission authority, owned API process adapter and outer
supervisor/post-controller qualification path are not implemented. No source, receipt, boolean observation,
caller-supplied zero exit code or module authorizes a runtime session.

VM4014 remains excluded entirely, including probes. VM106 is excluded.
VM107's stopped/onboot/hook/launch hold and VM218's disabled CI/unresolved QA34
storage-measurement cause remain governed by their owners. No boot, import,
compile, build, test, install, admission, provider or application launch is
authorized by this guide. Existing production routes stay unchanged.

## Selected component and current separation

Source paths: apps/worker/tests/native/_billing_B7_phase_journal.py and
apps/worker/tests/native/_billing_B7_owned_driver.py.
This file has no CLI and opens nothing at import. B7PhaseJournal.create() is a
future filesystem operation requiring the owner's admitted private parent.
The journal does not launch a process, connect to a database, kill a group,
cancel an executor, inspect backend state or delete a job directory.

The paired worker session and API phase remain separate selected source
bodies. The worker session still requires a fresh actually verified empty
disposable target and cannot reattach or retry retained rows. The journal
provides a durable record order around those owners, not their assertions or
native proof. The ordinary ten-method/21-scenario worker suite and one
API-positive phase/two handler calls are unchanged. No new passing test or
completed review is counted for this component.

## Owned directory and file publication

The future driver supplies a canonical absolute parent that already exists
with its effective UID and exact0700 directory mode. The journal only creates
the fixed billing-B7-<32hex job ID> child. mkdir is exclusive; an existing job
fails before adoption, overwrite or launch. A one-shot admission must never
reuse an old job ID after external retention removes a directory. This
journal cannot reconstruct historical allocations outside retained evidence.

The component keeps parent, job and lock descriptors, checks their
device/inode/UID/mode/path identities, acquires nonblocking flock on the
exclusive0600 .controller.lock file and limits mutations to its creator PID.
A process-local mutex serializes phase operations. The driver must pass
close_fds to the child and keep one active owner. Hostile root/same-UID writers,
namespace changes, filesystem semantics and parent immutability remain owner
qualification concerns; directory modes are not storage isolation.

Each JSON asset or receipt is at most64KiB. Writes handle short writes, fsync
the allocated regular owner-private file, link its exact temporary inode to
the final fixed name without clobber, unlink the allocated temporary name,
fsync the directory and read back exact bytes. Existing final files,
including symlinks, are never replaced. Temporary deletion checks the exact
allocated device/inode and retains an unknown replacement. That check is not
an atomic defense against a malicious same-UID writer racing unlink.

Reads are FD-relative with O_NOFOLLOW/O_NONBLOCK, regular owner-private
single-link validation, a byte bound, UTF8/JSON/duplicate-key/nonfinite
validation and unchanged inode/size/mtime/ctime observations. O_NONBLOCK and
size caps do not establish absolute filesystem I/O deadlines or crash
durability across every backing filesystem. Those require native evidence
and the outer owner supervisor.

Publication can fail after an asset is durable but before its binding receipt.
The operation becomes broken; no in-process retry or overwrite is permitted.
Partial directories/files/locks remain recovery evidence. The journal closes
only its own descriptors and deletes only exact operation-owned temporary
files; it never removes published phases, data, source or directories.

## Required future driver sequence

| Order | Actual future owner action | Journal artifact and boundary |
| --- | --- | --- |
| 0 | Clear incident/runtime holds independently, admit isolated bounded no-egress job, verify exact source/install/dependency/target evidence before imports | create records only target-receipt/source-manifest hashes in00-owner-journal.json; JSON is not admission |
| 1 | Enter actual B7WorkerSession, call start() and establish committed SENT A plus literal client oracle | worker-handoff.json retains exact producer bytes;01-worker-handoff-binding.json records SHA/bytes/event and preceding receipt |
| 2 | Run the single actual API fixture with explicit receipt/handoff/result paths and verified node/Vitest/config/source bytes; observe zero actual child exit and owned-group settlement | record_api_exit writes02-api-exit-observation.json from caller observations; journal never observes a child itself |
| 3 | Read the protected actual API result after that exit; bind source/job/event/rotation1/duplicate0 | api-native-result.json is produced by API;03-api-result-binding.json hashes it; return exact bytes to worker |
| 4 | Call session.finish() with those exact bytes and actual observed exit; verify actual SQL row/backoff/drift/no-send/frozen-A resend | worker-resend.json preserves exact producer bytes;04-worker-resend-binding.json retains cleanupVerifiedfalse |
| 5 | Exit worker context successfully, inspect exact owned row cleanup, actually settled executor/API group and job backends, retain owner observer evidence |05-cleanup-observations.json records caller observations and observer receipt hash; journal does not verify database/processes |
| 6 | Complete the ordered local receipts, close journal and actually exit controller successfully |06-sequence-not-terminal.json explicitly nativeQualifiedfalse/releaseQualifiedfalse and requires external final owner readbacks |
| Failure | Preserve original and cleanup failures, stop phase continuation, settle only exactly owned resources and obtain owner recovery evidence |99-failure.json uses a bounded secret-free code, prior receipt hashes and failed phase; no automatic retry/resume or journal data/process cleanup |

Every journal receipt has schema/job/writer PID/ordinal/time and the previous
receipt SHA. Source/result/target hashes are binding metadata, not signatures
or attestation that their referenced artifacts were approved. The future
driver must retain and verify the actual referenced bodies. The terminal
qualification consumer must re-read the chain and all referenced assets,
treat any99-failure file or nonzero real exit as failure, and reject missing,
mismatched, stale, expired or uncertain evidence.

A body exception after sequence completion appends failure; the sequence
receipt cannot suppress a later error. A failure to persist failure evidence
is itself unqualified and must be captured by the outer supervisor. Unsafe
namespace ownership prevents further writes. Descriptor close errors, abrupt
termination, missing journal steps or an absent final owner record do not
turn a sequence file into a pass.

## Trusted owner process adapter and supervisor still required

The authored coordinator requires a separately reviewed owner authority and
process adapter implementing the explicit lease/child protocols. Qualify the
immutable plan/job/source/target/artifact identity and protected bounded reads.
Require owner enforcement of the approved32GiB job limit, fresh backing/
parent capacity checks, bounded concurrency/retention and true egress
containment. Guest df, a separate VM on an unbounded pool, JSON flags or a
module mock are insufficient. The current CI disablement remains until applicable
QA34/owner/policy clearance. Development admission and release candidate/signing
promotion are separate; release signing alone is not a development-test gate.

Use a fixed exact-source local executable command, never a shell, network
installer or generic caller-supplied command. Clear ambient provider,
database, SSO and credential environment; provide only the three protected
API phase paths and reviewed fixture settings. Bind the child to its owned
process/job identity before any signal or cleanup. Bound stdout/stderr and
retain evidence without credential leakage. A process exit alone does not
prove no detached child or active PostgreSQL session.

Enforce a finite child and overall job deadline with the owner's supervisor.
Do not restart after an observation timeout. Wait/cancel/reap only known owned
handles; preserve both original and cleanup failures. asyncio wait_for does
not cancel to_thread SQL work, Vitest observation deadlines do not terminate
all work, and a filesystem operation can block. Whole-job cancellation and
post-exit cgroup/process/backend/storage readbacks need actual independent
evidence before native qualification.

Failure recovery must not reattach this fixture to retained rows or rewrite
historical phase artifacts. Inspect retained evidence with the infrastructure
owner, reconcile all owned native resources, and admit a new one-shot job
only after clearance. No broad cleanup, existing database purge, volume
deletion, hypervisor change or VM restart is included.


## Authored callable coordinator — owner implementation absent

run_owned_b7(plan_path, authority=...) has no CLI, default authority or
import-time I/O. The authority is a trusted launcher integration, not a JSON
flag or any arbitrary object satisfying a Protocol. Its immutable approved
implementation must enforce the actual applicable user/incident/runtime/CI
holds and job isolation independently. A goal continuation, idle task,
successful hash readback or owner-produced JSON cannot lift the VM107 hold.

The outer owner supervisor must cover startup before plan/source reads or
imports, enforce a finite maximum180seconds/32GiB job and true egress/backing
bounds, and admit only immutable source/install provenance approved for the
specific development or release pipeline. Matching signing-policy promotion
is additionally required for release qualification, not all development tests. Its implementation is absent here. OwnerAuthority.admit,
OwnerLease.require_live/spawn_api/observe_local_resources and OwnedApiChild
collect/settle are contracts; they do not themselves implement physical
admission, process supervision, quotas, signaling or observations.

The callable coordinator validates a private canonical owner-single-link
bounded plan and receipt, expiry, exact job binding and a selected source
manifest. It hashes every selected source, fixed runtime helper/API/config/
schema/service/secure-http/package bodies, its own selected source body and
the explicit local node/Vitest executable bytes. Source/helper bodies are
compiled from exact hash-bound buffers only after the actual owner lease.
The outer loader must verify the coordinator before importing it; a self
readback cannot undo an already executed malicious module.

The current static frozen-base pins reject overlapping changes, including a
composed API package/typecheck change. A fully composed candidate needs a
fresh reviewed source selection and refreshed driver bindings; no old hash
can silently qualify another body. The source selection may be at most1MiB,
each selected source8MiB, plan/target/phase JSON64KiB, node256MiB and raw
API log1MiB. These are component bounds, not observed whole-job isolation.
Actual loader/TypeScript/Prisma/Psycopg/dependency/native behavior is absent.

The closed plan object has exactly these fields:

| Field | Future owner value |
| --- | --- |
| kind / schemaVersion | billing-B7-owned-controller-plan / integer1 |
| ownerJobId / expiresAtUtc | One-shot32hex job ID / future timezone-aware expiry |
| repositoryRoot / artifactParent | Exact approved integration build root / canonical existing owner0700 artifact parent within RUNNER_TEMP |
| targetReceiptPath / targetReceiptSha256 | Protected actual admitted synthetic target receipt / exact bytes SHA |
| sourceSelectionPath / sourceSelectionSha256 | Protected reviewed selected source manifest / exact bytes SHA |
| nodeExecutable / nodeSha256 | Canonical exact local executable / install-qualified exact SHA |
| vitestEntry / vitestSha256 | Canonical exact local entry under candidate-root node_modules / install-qualified exact SHA |

The coordinator rechecks plan/selection/target receipt after admission and
source/input/executable bytes before the API child and after cleanup.
Python helper namespace entries must not preexist; they use exact buffers,
and cleanup removes only the exact module objects this driver registered.
An untrusted cache/replacement or final hash mismatch fails. Filesystem
blocking, hostile same-UID races and physical immutable mounts still need
owner enforcement, not just before/after hashes.

The API request is fixed local node + Vitest run + the selected dedicated
native config in apps/api. No shell, installer, generic user command,
ordinary unit capability fallback or provider credential is supplied.
The owner adapter must use the supplied argv/cwd/environment verbatim.
The child receives explicit protected receipt/handoff/result paths, UTC/
production mode, a private job home/cache and a small executable PATH.
The source binding hashes exact job/target/source/executable/runtime/base
pins and argv/cwd/environment, not just an exit flag.

The adapter must actually create and own the child and all descendants,
enforce a finite maximum40second API observation, close inherited journal
descriptors, collect/reap and retain bounded full output in api-output.log.
Its api-child-receipt.json must bind kind billing-B7-owned-api-child,
ownerJobId, actual integer PID/zero returncode, actual owned-group absence,
sourceBindingSha256, fullLogRetainedtrue and exact logBytes/logSha256.
An empty full log is valid. On overflow, retain bounded evidence, mark the
log incomplete and fail; missing output cannot support a passing conclusion.

Raw owner-private logs and original exception objects can contain synthetic
database credentials. They must remain secret-sensitive full task evidence,
never console/public artifact exports. The owner launcher must catch all
failures, emit bounded secret-free status and retain full sensitive evidence
privately. OwnedDriverFailure exposes only a fixed stage code in its string;
its causes preserve original/body/settlement/context-cleanup failures in
memory and are not JSON/representation exports. No direct CLI prints them.

After successful actual child collection, the coordinator checks exact
receipt/log bindings and calls the adapter's actual settle method before
recording exit. Only then may it bind the actual API result and call actual
session.finish(). A result file or caller receipt never replaces owned
physical settlement. The adapter implementation itself must be verified.

If API startup raises before returning an owned handle, settlement is
unknown and the target is poisoned. If owned child settlement fails, the
target is also poisoned. Automatic worker row cleanup then cannot open that
target and race an API mutator. Retain the target/artifacts for owner recovery,
record failure and never blindly retry. On known safe settlement, the worker
context executes its exact owned cleanup; both primary and cleanup errors
are retained rather than treating cleanup as success.

After successful worker-context exit, the driver requires the helper's
actual cleanup_verified flag, compares currently alive Python threads with
the baseline and queries real pg_stat_activity through the actual verified
Psycopg target. That query observes zero other backends for this exact job
database/role while its inspector connection is open. It does not prove
zero after inspector close/controller exit or account for every native OS
thread. Those remain explicit owner final readbacks.

The owner adapter must inspect actual resources and write protected
owner-local-observer.json, binding kind billing-B7-owner-local-observation,
job ID, integer actual child PID, group/Python-thread settlement, enforced
job bytes, true physical no-egress/backing bounds and
postControllerQualificationRequiredtrue. The coordinator validates/hashes
that artifact and records local cleanup observations. JSON fields cannot
authenticate the absent owner implementation or qualify resource state.

A maximum120second coordinator observation deadline is checked between
phases and delegated operations; it is not cancellation of arbitrary I/O/
SQL/executor work. The lease's real finite outer deadline and owned-handle
semantics are mandatory. A past deadline or expired receipt fails rather
than authorizing another wait/retry. All source/native deadline behavior
requires actual evidence.

The returned result remains nativeQualifiedfalse/releaseQualifiedfalse and
requires post-controller owner qualification. Journal close and exact
module cleanup occur before return; lease exit/controller actual exit,
external final cgroup/backend/storage observations and independent review
remain native gates. Candidate/signing promotion additionally remains a
release-pipeline gate. Any failure after the local
sequence record, including outer cleanup/admission failure, must invalidate
qualification even if the nonterminal sequence file remains present.

## Required future adversarial and native qualification

The following are source-review/native obligations, not authored executable
tests, passing cases or completed review credit:

| Boundary | Required coverage |
| --- | --- |
| Directory allocation | Fresh canonical private parent; existing/stale job; nonprivate/wrong UID/symlink parent; partial setup; changed parent/job/lock identities |
| Writer ownership | One creator PID, inherited descriptors/fork misuse, competing process lock, competing thread phase ordering, namespace changes |
| Publication | Short writes/fsync/link/readback failures, existing regular/symlink final, temp inode replacement, asset durable before receipt failure, no published overwrite/delete |
| Input | Empty/oversized/growing/nonregular/symlink/hard-linked/nonprivate files; duplicate/nonfinite/malformed JSON; mismatched job/row/source/phase/result hashes |
| Sequence | Missing/out-of-order/duplicate phase, caller false exit/settlement fields, cleanupVerifiedfalse preserved, unknown or secret-bearing failure code |
| Failure persistence | Exception before/after sequence completion, cleanup failure, failure-receipt write failure, descriptor close failure, abrupt process termination |
| Actual child and worker | Pinned actual loader/Prisma/Psycopg source, no unit capability fallback, actual child exit, no detached group member, real DB transactions/backoff/resend and exact request bytes |
| Owner terminal gates | Verified executor/backend/cgroup/storage settlement after controller exit, no egress, limits/provenance plus release-specific signing, no stale admission/job reuse or receipt-only qualification |

Independent review, native filesystem/locking/durability, syntax/type/loader,
process/thread/socket/server/cleanup behavior and all runtime receipts are
absent. Full B7 source execution remains incomplete until the trusted owner admission/
process adapter, outer supervisor and post-controller qualification path exist
and are tested with the coordinator, journal and actual worker/API owners. All84 workflows,
47 browser surfaces,32 pipeline gates, actual credential/TOTP/provider/device/
populated upgrade/restore and months of private testing remain separate
incomplete release requirements. No production-ready claim is made.

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
