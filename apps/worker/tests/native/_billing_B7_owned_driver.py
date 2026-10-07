"""SOURCE DRAFT: B7 coordinator, callable only from a qualified owner launcher.

No CLI, import-time I/O, default authority, process adapter or automatic launch.
The owner runtime authority/process adapter is NOT implemented by this module.
It must independently enforce incident clearance, immutable reviewed source/
install provenance for the approved development pipeline, isolated32GiB storage,
no egress and an outer hard deadline. Release signing is a separate release gate.
JSON and supplied Python objects do not establish that authority by themselves.
Native runtime is unexecuted; no native or release qualification.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import json
import math
import os
from pathlib import Path, PurePosixPath
import re
import stat
import sys
import threading
import time
from types import ModuleType
from typing import Protocol

JOB_BYTES = 32 * 1024 ** 3
OUTER_SECONDS = 180
OBSERVATION_SECONDS = 120
API_SECONDS = 40
LOG_BYTES = 1048576
JSON_BYTES = 65536
SOURCE_BYTES = 8388608
DRIVER_PATH = "apps/worker/tests/native/_billing_B7_owned_driver.py"
RUNTIME_PINS = {
    "apps/worker/src/billing_usage.py": "a0e80169c98368eb7c34b1904790cb819a603d5d0f89022fa9edf996e702cc63",
    "apps/worker/tests/native/_billing_native_target.py": "098bb987b17713332963e7344a6f22a5fc9e0cc02e0037ee21f3a9aeb9cadd7e",
    "apps/worker/tests/native/_billing_B7_worker_session.py": "5a04c5154d8aff59c51707b0a398ee2377164f1b90b52ef4be9803b839cf0673",
    "apps/worker/tests/native/_billing_B7_phase_journal.py": "82ec29aed709a789bb0d5245060a87e8e59cf2ae91aa536c6173a4d9d6bd520d",
    "apps/api/test/native/billing-api-rotation.native.ts": "aa7246ce4b29197a38544e8304e23aed59dbd67db1c553d707b597f38f9a1934",
    "apps/api/vitest.billing-native.config.ts": "e8b334e28c009e272321ee691661a9384dbde52a6570855ab0afe95365e63877",
    "apps/api/tsconfig.billing-native.json": "71b750bde8ef666a59cc4d2a80525aa82e9d975e57b78b5d83018ebab4f86a6f",
}
BASE_PINS = {
    "packages/db/prisma/schema.prisma": "08a4febaeffb80bd04b36b78bfd96881f14df0bd7d0c84b70c672a3ccb1ad20d",
    "apps/api/src/billing/stripe-meter-error.service.ts": "848a138658063007b237c7c48514523deb9190fcb26d63e7d38f1e397ab907fe",
    "apps/api/src/database/tenant-prisma.service.ts": "0a4a9040cf2b32de30552d2725c949c00b44816b51d83e230670e6f409ec37d1",
    "apps/api/src/common/secure-http-client.ts": "894e9a851767860b504539488d2e0914b24bcf4a4cd3c73548bf18010f54d961",
    "apps/api/package.json": "a72ead28e2fd3a7e7e2e2103dbc99f63cac3435698869b08b5d3ead2511a7a77",
    "scripts/run-internal-ci-integration.sh": "e73a0d3f9b428e2cd31e291ce1f9079cc2af240a65af452eef1ef4c76ae0579e",
    "scripts/check-internal-ci-target.py": "fb0fa3411872431533b585db7880911da081086d912aabca4f72c1318e76323a",
    "scripts/check-internal-ci-storage.py": "da417e4c28eed913632aeb5e4b02edeac7f029c60118970f54104dcd53c5eec7",
}


class OwnedApiChild(Protocol):
    pid: int
    def collect(self, *, deadline: float, artifact_directory: Path,
                max_log_bytes: int) -> None: ...
    def settle(self, *, deadline: float) -> bool: ...


class OwnerLease(Protocol):
    # Trusted owner implementation must already be covered by the outer
    # supervisor before plan/source reads or imports. These are contracts,
    # not a provided implementation or enforcement by a structural type.
    deadline: float
    ci_run_id: str
    ci_source_sha: str
    target_preflight_sha256: str
    def require_live(self) -> None: ...
    def spawn_api(self, *, argv: list[str], cwd: Path, env: dict[str, str],
                  artifact_directory: Path, source_binding_sha256: str,
                  deadline: float, max_log_bytes: int) -> OwnedApiChild: ...
    def observe_local_resources(self, *, artifact_directory: Path,
                                target_identity: dict, api_child: OwnedApiChild,
                                deadline: float) -> None: ...


class OwnerAuthority(Protocol):
    def admit(self, *, plan: dict, plan_sha256: str, selection_sha256: str,
              target_receipt_sha256: str, max_job_bytes: int,
              maximum_overall_seconds: int): ...


class OwnedDriverFailure(RuntimeError):
    def __init__(self, code, causes):
        super().__init__(code)  # Bounded secret-free console representation.
        self.code = code
        self.causes = tuple(causes)  # Sensitive original/cleanup exceptions; never JSON/repr export.


def require(value, code):
    if not value:
        raise RuntimeError(code)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value),
            "SOURCE_BINDING_FAILED")
    return value


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "PHASE_OWNERSHIP_FAILED")
        result[key] = value
    return result


def parse(body):
    def bad_constant(value):
        raise RuntimeError("PHASE_OWNERSHIP_FAILED")
    value = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object,
                       parse_constant=bad_constant)
    require(isinstance(value, dict), "PHASE_OWNERSHIP_FAILED")
    return value


def canonical(value):
    require(isinstance(value, str), "PHASE_OWNERSHIP_FAILED")
    path = Path(value)
    require(path.is_absolute() and path.resolve(strict=True) == path,
            "PHASE_OWNERSHIP_FAILED")
    return path


def file_bytes(path, maximum, *, private=False, allow_empty=False):
    fd = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1
                and 0 <= before.st_size <= maximum
                and (allow_empty or before.st_size > 0), "PHASE_OWNERSHIP_FAILED")
        if private:
            require(before.st_uid == os.geteuid() and before.st_mode & 0o077 == 0,
                    "PHASE_OWNERSHIP_FAILED")
        chunks = []
        used = 0
        while used <= maximum:
            chunk = os.read(fd, min(65536, maximum + 1 - used))
            if not chunk:
                break
            chunks.append(chunk)
            used += len(chunk)
        after = os.fstat(fd)
        require(used == before.st_size and used <= maximum
                and (before.st_dev, before.st_ino, before.st_size,
                     before.st_mtime_ns, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size,
                    after.st_mtime_ns, after.st_ctime_ns), "PHASE_OWNERSHIP_FAILED")
        return b"".join(chunks)
    finally:
        os.close(fd)


def unexpired(value):
    require(isinstance(value, str), "PHASE_OWNERSHIP_FAILED")
    expiry = datetime.fromisoformat(value.replace("Z", "+00:00"))
    require(expiry.tzinfo is not None and expiry > datetime.now(timezone.utc),
            "PHASE_OWNERSHIP_FAILED")



def existing_controller_binding(target):
    require(target.get("schemaVersion") == 2
            and target.get("cleanupOwnership") == "exact-controller-job-fixture-rows"
            and target.get("database") == "lunchlineup_test"
            and target.get("role") == "lunchlineup_ci_app", "PHASE_OWNERSHIP_FAILED")
    binding = target.get("controllerBinding")
    require(isinstance(binding, dict) and set(binding) == {
        "ciRunId", "ciSourceSha", "preflightPath", "preflightSha256",
    }, "PHASE_OWNERSHIP_FAILED")
    run = binding["ciRunId"]
    source_sha = binding["ciSourceSha"]
    require(isinstance(run, str) and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", run)
            and isinstance(source_sha, str) and re.fullmatch(r"[a-f0-9]{40}", source_sha),
            "PHASE_OWNERSHIP_FAILED")
    workspace = "/var/lib/custom-ci/workspaces/" + run
    temporary = "/var/lib/custom-ci/runs/" + run + "/tmp/job-tmp"
    build = temporary + "/lunchlineup-source-" + run + "/build"
    expected_path = workspace + "/.release/internal-ci/" + source_sha + "/integration-target.json"
    require(binding["preflightPath"] == expected_path, "PHASE_OWNERSHIP_FAILED")
    blob = file_bytes(canonical(expected_path), JSON_BYTES, private=True)
    require(digest(blob) == sha(binding["preflightSha256"]), "SOURCE_BINDING_FAILED")
    prefix = "lunchlineup-integration-" + re.sub(r"[^a-zA-Z0-9]", "", run)
    require(parse(blob) == {
        "runId": run, "sourceSha": source_sha, "workspace": workspace,
        "temporaryRoot": temporary, "mutationRole": "lunchlineup_ci_app",
        "dataTargetEnvironment": "disposable", "database": "lunchlineup_test",
        "store": temporary + "/lunchlineup-integration-containers-" + run,
        "containers": [prefix + "-" + name for name in ("postgres", "redis", "rabbitmq")],
    }, "PHASE_OWNERSHIP_FAILED")
    return {**binding, "runnerTemp": temporary, "buildRoot": build}


def prepared_plan(plan_path):
    body = file_bytes(canonical(plan_path), JSON_BYTES, private=True)
    plan = parse(body)
    expected = {
        "kind", "schemaVersion", "ownerJobId", "expiresAtUtc",
        "repositoryRoot", "artifactParent", "targetReceiptPath", "targetReceiptSha256",
        "sourceSelectionPath", "sourceSelectionSha256",
        "nodeExecutable", "nodeSha256", "vitestEntry", "vitestSha256",
    }
    require(set(plan) == expected and plan["kind"] == "billing-B7-owned-controller-plan"
            and type(plan["schemaVersion"]) is int and plan["schemaVersion"] == 1
            and re.fullmatch(r"[a-f0-9]{32}", plan["ownerJobId"]),
            "PHASE_OWNERSHIP_FAILED")
    unexpired(plan["expiresAtUtc"])
    root = canonical(plan["repositoryRoot"])
    parent = canonical(plan["artifactParent"])
    node = canonical(plan["nodeExecutable"])
    vitest = canonical(plan["vitestEntry"])
    vitest.relative_to(root / "node_modules")  # No ambient/global installer or test runner.
    selection_body = file_bytes(canonical(plan["sourceSelectionPath"]), 1048576, private=True)
    target_body = file_bytes(canonical(plan["targetReceiptPath"]), JSON_BYTES, private=True)
    require(digest(selection_body) == sha(plan["sourceSelectionSha256"])
            and digest(target_body) == sha(plan["targetReceiptSha256"]),
            "SOURCE_BINDING_FAILED")
    target = parse(target_body)
    require(target.get("ownerJobId") == plan["ownerJobId"], "PHASE_OWNERSHIP_FAILED")
    unexpired(target.get("expiresAtUtc"))
    controller = existing_controller_binding(target)
    require(root == Path(controller["buildRoot"]), "PHASE_OWNERSHIP_FAILED")
    parent.relative_to(Path(controller["runnerTemp"]))
    selection = parse(selection_body)
    entries = selection.get("sourceProposals")
    require(isinstance(entries, list) and 0 < len(entries) <= 128, "SOURCE_BINDING_FAILED")
    pins = {}
    for entry in entries:
        require(isinstance(entry, dict) and isinstance(entry.get("sourcePath"), str),
                "SOURCE_BINDING_FAILED")
        rel = PurePosixPath(entry["sourcePath"])
        require(not rel.is_absolute() and ".." not in rel.parts and str(rel) == entry["sourcePath"]
                and str(rel) not in pins, "SOURCE_BINDING_FAILED")
        pins[str(rel)] = sha(entry.get("sha256"))
    require(all(pins.get(name) == value for name, value in RUNTIME_PINS.items())
            and DRIVER_PATH in pins, "SOURCE_BINDING_FAILED")
    own_path = canonical(str(Path(__file__)))
    require(own_path == root / DRIVER_PATH, "SOURCE_BINDING_FAILED")
    blobs = {}
    for name, expected_sha in {**pins, **BASE_PINS}.items():
        path = canonical(str(root / name))
        blob = file_bytes(path, SOURCE_BYTES)
        require(digest(blob) == expected_sha, "SOURCE_BINDING_FAILED")
        blobs[name] = blob
    require(digest(file_bytes(node, 268435456)) == sha(plan["nodeSha256"])
            and digest(file_bytes(vitest, SOURCE_BYTES)) == sha(plan["vitestSha256"]),
            "SOURCE_BINDING_FAILED")
    return plan, digest(body), root, parent, node, vitest, blobs, controller


@contextmanager
def native_modules(root, blobs):
    loaded = []
    try:
        for name, relative in (
            ("_billing_native_target", "apps/worker/tests/native/_billing_native_target.py"),
            ("_billing_B7_worker_session", "apps/worker/tests/native/_billing_B7_worker_session.py"),
            ("_billing_B7_phase_journal", "apps/worker/tests/native/_billing_B7_phase_journal.py"),
        ):
            require(name not in sys.modules, "SOURCE_BINDING_FAILED")
            module = ModuleType(name)
            module.__file__ = str(root / relative)
            sys.modules[name] = module
            loaded.append((name, module))
            # Future admitted execution only; compile/exec exactly hash-bound
            # bytes, never a loader reread or a preexisting cached fake helper.
            exec(compile(blobs[relative], module.__file__, "exec"), module.__dict__)
        yield {name: module for name, module in loaded}
    finally:
        mismatches = []
        for name, module in reversed(loaded):
            if sys.modules.get(name) is module:
                sys.modules.pop(name)
            else:
                mismatches.append(name)  # Preserve another owner's replacement.
        require(not mismatches, "SOURCE_BINDING_FAILED")


def live(lease, deadline, plan):
    lease.require_live()
    require(time.monotonic() < deadline, "JOB_DEADLINE_EXCEEDED")
    unexpired(plan["expiresAtUtc"])


def input_recheck(plan_path, plan_sha, plan):
    require(digest(file_bytes(canonical(plan_path), JSON_BYTES, private=True)) == plan_sha
            and digest(file_bytes(canonical(plan["sourceSelectionPath"]), 1048576, private=True))
                == plan["sourceSelectionSha256"]
            and digest(file_bytes(canonical(plan["targetReceiptPath"]), JSON_BYTES, private=True))
                == plan["targetReceiptSha256"], "SOURCE_BINDING_FAILED")
    existing_controller_binding(parse(file_bytes(
        canonical(plan["targetReceiptPath"]), JSON_BYTES, private=True,
    )))


def source_recheck(root, blobs, node, vitest, plan, plan_path, plan_sha):
    input_recheck(plan_path, plan_sha, plan)
    for name, expected_body in blobs.items():
        require(file_bytes(canonical(str(root / name)), SOURCE_BYTES) == expected_body,
                "SOURCE_BINDING_FAILED")
    require(digest(file_bytes(node, 268435456)) == plan["nodeSha256"]
            and digest(file_bytes(vitest, SOURCE_BYTES)) == plan["vitestSha256"],
            "SOURCE_BINDING_FAILED")


def actual_other_backends(session, job):
    target = session.target
    require(target.receipt["ownerJobId"] == job, "BACKEND_SETTLEMENT_FAILED")
    expected_database, expected_role = "lunchlineup_test", "lunchlineup_ci_app"
    with target.connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT current_database(),current_user,current_setting('TimeZone')")
            require(cursor.fetchone() == (expected_database, expected_role, "UTC"), "BACKEND_SETTLEMENT_FAILED")
            cursor.execute(
                "SELECT pid,state,application_name FROM pg_stat_activity "
                "WHERE datname=%s AND usename=%s AND pid<>pg_backend_pid() "
                "ORDER BY pid LIMIT 17", (expected_database, expected_role),
            )
            rows = cursor.fetchall()
            require(rows == [], "BACKEND_SETTLEMENT_FAILED")
    # Only zero other job-role backends observed while this inspector was
    # connected. Final zero-after-controller/backend close needs owner proof.
    return True


def run_owned_b7(plan_path, *, authority):
    require(authority is not None, "PHASE_OWNERSHIP_FAILED")
    plan, plan_sha, root, parent, node, vitest, blobs, controller = prepared_plan(plan_path)
    # No application import/native connection/child/directory allocation occurs
    # before an independently qualified owner admission and live lease.
    with authority.admit(plan=plan, plan_sha256=plan_sha,
                         selection_sha256=plan["sourceSelectionSha256"],
                         target_receipt_sha256=plan["targetReceiptSha256"],
                         max_job_bytes=JOB_BYTES, maximum_overall_seconds=OUTER_SECONDS) as lease:
        require(type(lease.deadline) in (int, float) and math.isfinite(lease.deadline)
                and 0 < lease.deadline - time.monotonic() <= OUTER_SECONDS,
                "JOB_DEADLINE_EXCEEDED")
        deadline = min(time.monotonic() + OBSERVATION_SECONDS, lease.deadline)
        live(lease, deadline, plan)
        require(lease.ci_run_id == controller["ciRunId"]
                and lease.ci_source_sha == controller["ciSourceSha"]
                and lease.target_preflight_sha256 == controller["preflightSha256"],
                "PHASE_OWNERSHIP_FAILED")
        input_recheck(plan_path, plan_sha, plan)
        with native_modules(root, blobs) as modules:
            journal_type = modules["_billing_B7_phase_journal"].B7PhaseJournal
            worker_type = modules["_billing_B7_worker_session"].B7WorkerSession
            with journal_type.create(
                parent, owner_job_id=plan["ownerJobId"],
                target_receipt_sha256=plan["targetReceiptSha256"],
                source_manifest_sha256=plan["sourceSelectionSha256"],
            ) as journal:
                stage = "WORKER_SETUP_FAILED"
                causes = []
                child = None
                session = None
                child_settled = False
                api_spawn_attempted = False
                try:
                    baseline_threads = {thread.ident for thread in threading.enumerate()}
                    with worker_type(plan["targetReceiptPath"]) as session:
                        try:
                            live(lease, deadline, plan)
                            stage = "WORKER_START_FAILED"
                            journal.record_worker_handoff(session.start())
                            source_recheck(root, blobs, node, vitest, plan, plan_path, plan_sha)
                            live(lease, deadline, plan)
                            stage = "API_START_FAILED"
                            api_argv = [str(node), str(vitest), "run", "--config",
                                        str(root / "apps/api/vitest.billing-native.config.ts")]
                            api_cwd = root / "apps/api"
                            api_env = {
                                "PATH": "/usr/bin:/bin", "TZ": "UTC", "NODE_ENV": "production",
                                "HOME": str(journal.directory_path),
                                "XDG_CACHE_HOME": str(journal.directory_path / "cache"),
                                "BILLING_NATIVE_TARGET_RECEIPT": plan["targetReceiptPath"],
                                "BILLING_NATIVE_WORKER_HANDOFF": str(journal.directory_path / "worker-handoff.json"),
                                "BILLING_NATIVE_API_RESULT": str(journal.api_result_path),
                            }
                            binding = digest(json.dumps({
                                "ownerJobId": plan["ownerJobId"],
                                "selectedSourceSha256": plan["sourceSelectionSha256"],
                                "targetReceiptSha256": plan["targetReceiptSha256"],
                                "controllerBinding": controller,
                                "nodeSha256": plan["nodeSha256"], "vitestSha256": plan["vitestSha256"],
                                "runtimePins": RUNTIME_PINS, "basePins": BASE_PINS,
                                "argv": api_argv, "cwd": str(api_cwd), "env": api_env,
                            }, sort_keys=True, separators=(",", ":")).encode())
                            api_deadline = min(deadline, time.monotonic() + API_SECONDS)
                            api_spawn_attempted = True
                            child = lease.spawn_api(
                                argv=api_argv, cwd=api_cwd, env=api_env,
                                artifact_directory=journal.directory_path,
                                source_binding_sha256=binding, deadline=api_deadline,
                                max_log_bytes=LOG_BYTES,
                            )
                            require(type(child.pid) is int and child.pid > 0, "API_START_FAILED")
                            stage = "API_EXIT_FAILED"
                            child.collect(deadline=api_deadline, artifact_directory=journal.directory_path,
                                          max_log_bytes=LOG_BYTES)
                            receipt_body = file_bytes(
                                journal.directory_path / "api-child-receipt.json", JSON_BYTES, private=True,
                            )
                            child_receipt = parse(receipt_body)
                            require(child_receipt.get("kind") == "billing-B7-owned-api-child"
                                    and child_receipt.get("ownerJobId") == plan["ownerJobId"]
                                    and type(child_receipt.get("pid")) is int
                                    and child_receipt["pid"] == child.pid
                                    and type(child_receipt.get("returncode")) is int
                                    and child_receipt["returncode"] == 0
                                    and child_receipt.get("ownedGroupObservedEmpty") is True
                                    and child_receipt.get("sourceBindingSha256") == binding
                                    and child_receipt.get("fullLogRetained") is True,
                                    "API_EXIT_FAILED")
                            log = file_bytes(journal.directory_path / "api-output.log", LOG_BYTES,
                                             private=True, allow_empty=True)
                            require(digest(log) == sha(child_receipt.get("logSha256"))
                                    and type(child_receipt.get("logBytes")) is int
                                    and len(log) == child_receipt["logBytes"], "API_EXIT_FAILED")
                            # Trusted owner adapter must actually verify/reap all
                            # owned descendants. This receipt isn't that adapter.
                            child_settled = child.settle(deadline=min(deadline, time.monotonic() + 5))
                            require(child_settled is True, "PROCESS_SETTLEMENT_FAILED")
                            journal.record_api_exit(
                                pid=child.pid, returncode=0, child_source_binding_sha256=binding,
                                owned_group_observed_empty=True,
                            )
                            live(lease, deadline, plan)
                            stage = "API_RESULT_FAILED"
                            api_bytes = journal.record_api_result()
                            stage = "WORKER_FINISH_FAILED"
                            journal.record_worker_resend(session.finish(
                                api_bytes, observed_api_returncode=0,
                            ))
                        except BaseException as primary:
                            causes.append(primary)
                            if api_spawn_attempted and child is None:
                                # Startup may have created a mutator before an
                                # owned handle was returned. Unknown settlement
                                # forbids automatic data cleanup or blind retry.
                                session.target.poisoned = True
                            if child is not None and not child_settled:
                                try:
                                    child_settled = child.settle(
                                        deadline=min(lease.deadline, time.monotonic() + 5),
                                    )
                                    require(child_settled is True, "PROCESS_SETTLEMENT_FAILED")
                                except BaseException as settlement:
                                    causes.append(settlement)
                                    # Do not let automatic row cleanup race an
                                    # unsettled API mutator. Retain target/evidence
                                    # for owner recovery; helper cleanup will fail.
                                    session.target.poisoned = True
                            raise
                    stage = "ROW_CLEANUP_FAILED"
                    require(session.cleanup_verified is True and child_settled is True,
                            "ROW_CLEANUP_FAILED")
                    live(lease, deadline, plan)
                    stage = "BACKEND_SETTLEMENT_FAILED"
                    require(actual_other_backends(session, plan["ownerJobId"]),
                            "BACKEND_SETTLEMENT_FAILED")
                    require(not [thread for thread in threading.enumerate()
                                 if thread.ident not in baseline_threads and thread.is_alive()],
                            "PROCESS_SETTLEMENT_FAILED")
                    lease.observe_local_resources(
                        artifact_directory=journal.directory_path,
                        target_identity={"database": session.target.receipt["database"],
                                         "role": session.target.receipt["role"],
                                         "port": session.target.receipt["port"],
                                         "controllerBinding": controller},
                        api_child=child, deadline=deadline,
                    )
                    owner_body = file_bytes(
                        journal.directory_path / "owner-local-observer.json", JSON_BYTES, private=True,
                    )
                    owner = parse(owner_body)
                    require(owner.get("kind") == "billing-B7-owner-local-observation"
                            and owner.get("ownerJobId") == plan["ownerJobId"]
                            and type(owner.get("apiChildPid")) is int
                            and owner["apiChildPid"] == child.pid
                            and owner.get("apiProcessGroupEmpty") is True
                            and owner.get("workerPythonThreadsSettled") is True
                            and owner.get("enforcedJobBytes") == JOB_BYTES
                            and owner.get("physicalNoEgressEnforced") is True
                            and owner.get("actualBackingBoundsVerified") is True
                            and owner.get("postControllerQualificationRequired") is True,
                            "PROCESS_SETTLEMENT_FAILED")
                    live(lease, deadline, plan)
                    source_recheck(root, blobs, node, vitest, plan, plan_path, plan_sha)
                    journal.record_cleanup_observations(
                        owned_rows_zero=True, api_group_empty=True, worker_executor_settled=True,
                        other_job_backends_zero=True, owner_observer_receipt_sha256=digest(owner_body),
                    )
                    journal.record_sequence_receipts_complete()
                    result = {
                        "kind": "billing-B7-coordinator-local-sequence",
                        "ownerJobId": plan["ownerJobId"], "directory": str(journal.directory_path),
                        "controllerBinding": controller,
                        "planSha256": plan_sha, "sourceSelectionSha256": plan["sourceSelectionSha256"],
                        "apiChildReceiptSha256": digest(receipt_body),
                        "ownerLocalObserverSha256": digest(owner_body),
                        "sequenceReceiptSha256": journal.previous_receipt_sha,
                        "localSequenceReceiptsComplete": True, "nativeQualified": False,
                        "releaseQualified": False, "ownerPostControllerQualificationRequired": True,
                    }
                except BaseException as outer:
                    if not any(error is outer for error in causes):
                        causes.append(outer)  # Retain worker context cleanup failure as well.
                    if journal.phase != "FAILED":
                        try:
                            journal.record_failure(stage)
                        except BaseException as journal_failure:
                            causes.append(journal_failure)
                    raise OwnedDriverFailure(stage, causes) from None
        # Module cleanup and journal descriptor close happened before returning.
        # The trusted outer launcher must still observe real controller exit and
        # final cgroup/backend/storage state; this result can never promote CI.
        return result
