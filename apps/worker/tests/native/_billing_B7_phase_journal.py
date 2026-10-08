"""SOURCE DRAFT ONLY: durable B7 phase journal, not the controller driver.

No import performs filesystem/database/process I/O. No CLI or automatic launch.
A future admitted owner must enforce bounded isolated storage/no egress and a
whole-job supervisor before calling this component. It only owns a fresh
private phase directory and persists caller observations. It does not admit a
target, launch/wait/kill a child, cancel a worker, inspect PostgreSQL sessions,
repair a retained job, qualify tests or authorize a release.
"""
from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime, timezone
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import stat
import sys
import threading
import uuid

MAX_JSON_BYTES = 65536
SERVICE_SHA256 = "848a138658063007b237c7c48514523deb9190fcb26d63e7d38f1e397ab907fe"
TENANT_SHA256 = "0a4a9040cf2b32de30552d2725c949c00b44816b51d83e230670e6f409ec37d1"
ASSETS = {"worker-handoff.json", "api-native-result.json", "worker-resend.json"}
FAILURE_CODES = {
    "CONTROLLER_SCOPE_INCOMPLETE", "CONTROLLER_OPERATION_FAILED",
    "WORKER_SETUP_FAILED", "WORKER_START_FAILED", "WORKER_FINISH_FAILED",
    "API_START_FAILED", "API_EXIT_FAILED", "API_RESULT_FAILED",
    "JOB_DEADLINE_EXCEEDED", "SOURCE_BINDING_FAILED", "PROCESS_SETTLEMENT_FAILED",
    "BACKEND_SETTLEMENT_FAILED", "ROW_CLEANUP_FAILED", "PHASE_OWNERSHIP_FAILED",
}


def require(condition, reason):
    if not condition:
        raise RuntimeError(reason)


def digest(body):
    return hashlib.sha256(body).hexdigest()


def sha(value):
    require(isinstance(value, str) and re.fullmatch(r"[a-f0-9]{64}", value),
            "B7 source/result digest invalid")
    return value


def unique_object(pairs):
    value = {}
    for key, item in pairs:
        require(key not in value, "Duplicate B7 JSON key")
        value[key] = item
    return value


def reject_constant(value):
    raise RuntimeError("Non-finite B7 JSON number")


def decode(body):
    require(isinstance(body, bytes) and 0 < len(body) <= MAX_JSON_BYTES,
            "B7 JSON byte bound exceeded")
    value = json.loads(body.decode("utf-8"), object_pairs_hook=unique_object,
                       parse_constant=reject_constant)
    require(isinstance(value, dict), "B7 JSON must be an object")
    return value


def encoded(value):
    body = (json.dumps(value, ensure_ascii=True, allow_nan=False, sort_keys=True,
                       separators=(",", ":")) + "\n").encode("ascii")
    require(0 < len(body) <= MAX_JSON_BYTES, "B7 receipt byte bound exceeded")
    return body


def private_directory(info):
    require(stat.S_ISDIR(info.st_mode) and info.st_uid == os.geteuid()
            and stat.S_IMODE(info.st_mode) == 0o700,
            "B7 directory must be owner-private0700")


def private_file(info):
    require(stat.S_ISREG(info.st_mode) and info.st_uid == os.geteuid()
            and info.st_nlink == 1 and info.st_mode & 0o077 == 0,
            "B7 file must be regular, owner-private and single-link")


class B7PhaseJournal:
    """One fresh directory, one creator PID, one lock, immutable ordered receipts."""

    def __init__(self):
        raise RuntimeError("Use create() with an explicit owner-admitted private parent")

    @classmethod
    def create(cls, parent, *, owner_job_id, target_receipt_sha256,
               source_manifest_sha256):
        require(sys.platform.startswith("linux") and os.getuid() == os.geteuid(),
                "B7 journal requires admitted Linux without setuid execution")
        require(isinstance(owner_job_id, str)
                and re.fullmatch(r"[a-f0-9]{32}", owner_job_id), "Invalid B7 owner job")
        sha(target_receipt_sha256)
        sha(source_manifest_sha256)
        parent = Path(parent)
        require(parent.is_absolute() and parent.resolve(strict=True) == parent,
                "B7 parent must be an existing canonical absolute path without symlink aliases")
        obj = object.__new__(cls)
        obj.parent_path = parent
        obj.directory_name = "billing-B7-" + owner_job_id
        obj.directory_path = parent / obj.directory_name
        obj.job = owner_job_id
        obj.creator_pid = os.getpid()
        obj.target_receipt_sha = target_receipt_sha256
        obj.source_manifest_sha = source_manifest_sha256
        obj.parent_fd = obj.directory_fd = obj.lock_fd = None
        obj.mutex = threading.Lock()
        obj.closed = False
        obj.broken = False
        obj.phase = "ALLOCATING"
        obj.ordinal = 0
        obj.previous_receipt_sha = None
        obj.committed_receipts = []
        try:
            obj.parent_fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            private_directory(os.fstat(obj.parent_fd))
            obj.parent_identity = os.fstat(obj.parent_fd)
            # Exclusive directory creation is the stale-job/retry fence.
            # Never open, overwrite, adopt, remove or resume an existing job.
            os.mkdir(obj.directory_name, 0o700, dir_fd=obj.parent_fd)
            os.fsync(obj.parent_fd)
            obj.directory_fd = os.open(obj.directory_name,
                                      os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                                      dir_fd=obj.parent_fd)
            private_directory(os.fstat(obj.directory_fd))
            obj.directory_identity = os.fstat(obj.directory_fd)
            obj.lock_fd = os.open(".controller.lock",
                                  os.O_RDWR | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                                  0o600, dir_fd=obj.directory_fd)
            private_file(os.fstat(obj.lock_fd))
            obj.lock_identity = os.fstat(obj.lock_fd)
            fcntl.flock(obj.lock_fd, fcntl.LOCK_EX | fcntl.LOCK_NB)
            os.fsync(obj.lock_fd)
            os.fsync(obj.directory_fd)
            obj.phase = "STARTED"
            obj._receipt("00-owner-journal.json", {
                "kind": "billing-B7-journal-start",
                "targetReceiptSha256": obj.target_receipt_sha,
                "sourceManifestSha256": obj.source_manifest_sha,
                "freshDirectory": True, "automaticRetryOrResume": False,
                "observationsAreAdmission": False,
                "actualControllerDriverImplementedByThisModule": False,
                "ownerNativeQualificationRequired": True,
            })
            return obj
        except BaseException:
            # Preserve a partially allocated directory as recovery evidence.
            # No attempt to infer deletion permission from failed setup.
            obj.close()
            raise

    def __enter__(self):
        self._intact()
        return self

    def __exit__(self, exc_type, exc, traceback):
        try:
            if exc_type is not None and self.phase != "FAILED":
                # A body failure after sequence completion must remain durable.
                # The completion receipt is never a terminal pass and cannot
                # suppress the later failure receipt or actual failing exit.
                self.record_failure("CONTROLLER_OPERATION_FAILED")
            elif self.phase not in {"SEQUENCE_RECEIPTS_COMPLETE", "FAILED"}:
                self.record_failure("CONTROLLER_SCOPE_INCOMPLETE")
        finally:
            self.close()
        return False

    def _intact(self):
        require(not self.closed and os.getpid() == self.creator_pid,
                "B7 journal cannot be used after close or across a fork")
        private_directory(os.fstat(self.parent_fd))
        private_directory(os.fstat(self.directory_fd))
        private_file(os.fstat(self.lock_fd))
        parent_now = os.stat(self.parent_path, follow_symlinks=False)
        directory_now = os.stat(self.directory_name, dir_fd=self.parent_fd,
                                follow_symlinks=False)
        lock_now = os.stat(".controller.lock", dir_fd=self.directory_fd,
                           follow_symlinks=False)
        for actual, expected in ((parent_now, self.parent_identity),
                                 (directory_now, self.directory_identity),
                                 (lock_now, self.lock_identity)):
            require((actual.st_dev, actual.st_ino) == (expected.st_dev, expected.st_ino),
                    "B7 owned directory/lock identity changed")
        require(self.parent_path.resolve(strict=True) == self.parent_path,
                "B7 parent path acquired a symlink alias")

    @contextmanager
    def _operation(self, expected=None, *, allow_broken=False):
        with self.mutex:
            try:
                self._intact()
                require(allow_broken or not self.broken, "B7 failed operation prohibits retry")
                if expected is not None:
                    require(self.phase == expected, "B7 phase ordering failed")
                yield
            except BaseException:
                self.broken = True
                raise

    def _unlink_owned_temp(self, name, allocated):
        # Match the exact inode allocated by this operation before deletion.
        # This is an ownership check within the one-writer directory, not a
        # general defense against a malicious same-UID writer racing unlink.
        require(allocated is not None, "B7 temporary ownership unknown; retain file")
        actual = os.stat(name, dir_fd=self.directory_fd, follow_symlinks=False)
        require(stat.S_ISREG(actual.st_mode) and actual.st_uid == os.geteuid()
                and (actual.st_dev, actual.st_ino) == (allocated.st_dev, allocated.st_ino),
                "B7 temporary ownership changed; retain replacement")
        os.unlink(name, dir_fd=self.directory_fd)

    def _publish(self, name, body):
        """FD-relative atomic no-clobber link, bounded file, fsync and exact readback."""
        require(isinstance(name, str) and re.fullmatch(r"[a-zA-Z0-9._-]{1,80}", name),
                "Invalid fixed B7 publication name")
        require(isinstance(body, bytes) and 0 < len(body) <= MAX_JSON_BYTES,
                "B7 publication exceeds JSON bound")
        self._intact()
        temp = ".owned-" + uuid.uuid4().hex + ".tmp"
        fd = None
        created = False
        allocated = None
        try:
            fd = os.open(temp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW,
                         0o600, dir_fd=self.directory_fd)
            created = True
            allocated = os.fstat(fd)
            private_file(allocated)
            offset = 0
            while offset < len(body):
                count = os.write(fd, body[offset:])
                require(count > 0, "B7 short phase write")
                offset += count
            os.fsync(fd)
            os.close(fd)
            fd = None
            self._intact()
            # link() fails if name already exists, including a symlink/partial
            # previous publication. No rename-overwrite or check-then-replace.
            os.link(temp, name, src_dir_fd=self.directory_fd,
                    dst_dir_fd=self.directory_fd, follow_symlinks=False)
            self._unlink_owned_temp(temp, allocated)
            created = False
            os.fsync(self.directory_fd)
            require(self._read(name) == body, "B7 published bytes differ from readback")
        finally:
            if fd is not None:
                os.close(fd)
            if created:
                # Only the exact random temporary inode allocated by this
                # operation is disposable; never delete a published phase.
                self._unlink_owned_temp(temp, allocated)

    def _read(self, name):
        self._intact()
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK,
                     dir_fd=self.directory_fd)
        try:
            info = os.fstat(fd)
            private_file(info)
            require(0 < info.st_size <= MAX_JSON_BYTES, "B7 phase file size invalid")
            chunks = []
            used = 0
            while used <= MAX_JSON_BYTES:
                part = os.read(fd, min(8192, MAX_JSON_BYTES + 1 - used))
                if not part:
                    break
                chunks.append(part)
                used += len(part)
            require(used <= MAX_JSON_BYTES, "B7 phase grew beyond bound")
            after = os.fstat(fd)
            require((info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                    == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                    "B7 phase changed during read")
            body = b"".join(chunks)
            require(len(body) == info.st_size, "B7 phase file changed or read was incomplete")
            decode(body)
            return body
        finally:
            os.close(fd)

    def _receipt(self, name, value):
        value = dict(value)
        value.update(schemaVersion=1, ownerJobId=self.job, writerPid=self.creator_pid,
                     ordinal=self.ordinal, previousReceiptSha256=self.previous_receipt_sha,
                     recordedAtUtc=datetime.now(timezone.utc).isoformat(),
                     releaseQualified=False)
        body = encoded(value)
        self._publish(name, body)
        self.previous_receipt_sha = digest(body)
        self.committed_receipts.append({"name": name, "sha256": self.previous_receipt_sha})
        self.ordinal += 1
        return self.previous_receipt_sha

    def _owned_phase(self, body, kind):
        value = decode(body)
        require(value.get("kind") == kind and value.get("ownerJobId") == self.job
                and value.get("intervalSeconds") == 3600
                and value.get("tenantId") == "fixture_" + self.job + "_B7_one"
                and value.get("actualProvider") is False,
                "B7 phase job/owner/interval/synthetic binding failed")
        event_id = value.get("usageEventId")
        require(isinstance(event_id, str)
                and re.fullmatch(r"[A-Za-z0-9._:@+-]{1,128}", event_id),
                "B7 phase durable event identity invalid")
        return value

    @property
    def api_result_path(self):
        # The future driver must give only this path to the single actual API
        # child in the unchanged exclusive directory, then observe its exit.
        self._intact()
        return self.directory_path / "api-native-result.json"

    def record_worker_handoff(self, body):
        with self._operation("STARTED"):
            value = self._owned_phase(body, "billing-B7-worker-sent-A")
            self.event_id = value["usageEventId"]
            self._publish("worker-handoff.json", body)  # Preserve exact producer bytes.
            self._receipt("01-worker-handoff-binding.json", {
                "kind": "billing-B7-worker-handoff-binding",
                "asset": "worker-handoff.json", "assetSha256": digest(body),
                "bytes": len(body), "usageEventId": self.event_id,
            })
            self.phase = "WORKER_SENT"

    def record_api_exit(self, *, pid, returncode, child_source_binding_sha256,
                        owned_group_observed_empty):
        with self._operation("WORKER_SENT"):
            require(type(pid) is int and pid > 0 and type(returncode) is int and returncode == 0
                    and owned_group_observed_empty is True,
                    "B7 caller has not recorded successful settled API child")
            sha(child_source_binding_sha256)
            self._receipt("02-api-exit-observation.json", {
                "kind": "billing-B7-api-exit-observation", "pid": pid,
                "returncode": returncode, "ownedGroupObservedEmpty": True,
                "childSourceBindingSha256": child_source_binding_sha256,
                "callerSuppliedObservation": True, "journalObservedProcess": False,
            })
            self.phase = "API_EXIT_OBSERVED"

    def record_api_result(self):
        with self._operation("API_EXIT_OBSERVED"):
            body = self._read("api-native-result.json")
            value = self._owned_phase(body, "billing-B7-api-rotated-once")
            require(value["usageEventId"] == self.event_id
                    and value.get("eventId") == "evt_fixture_B7_" + self.job
                    and value.get("handlerSourceSha256") == SERVICE_SHA256
                    and value.get("tenantSourceSha256") == TENANT_SHA256
                    and value.get("first") == {"matched": 1, "transitioned": 1}
                    and value.get("duplicate") == {"matched": 1, "transitioned": 0},
                    "B7 API result identity/source/transition binding failed")
            self.api_result_sha = digest(body)
            self._receipt("03-api-result-binding.json", {
                "kind": "billing-B7-api-result-binding", "asset": "api-native-result.json",
                "assetSha256": self.api_result_sha, "bytes": len(body),
                "usageEventId": self.event_id,
                "actualCommittedRowVerificationRequiredByWorker": True,
                "processExitObservationReceipt": self.committed_receipts[-1],
            })
            self.phase = "API_ROTATED"
            return body

    def record_worker_resend(self, body):
        with self._operation("API_ROTATED"):
            value = self._owned_phase(body, "billing-B7-worker-resent-A")
            require(value["usageEventId"] == self.event_id
                    and value.get("apiResultSha256") == self.api_result_sha
                    and value.get("cleanupVerified") is False
                    and value.get("terminalReadbacksRequired") is True,
                    "B7 resend result/source/cleanup binding failed")
            self._publish("worker-resend.json", body)
            self._receipt("04-worker-resend-binding.json", {
                "kind": "billing-B7-worker-resend-binding", "asset": "worker-resend.json",
                "assetSha256": digest(body), "bytes": len(body), "usageEventId": self.event_id,
                "cleanupVerified": False, "terminalReadbacksRequired": True,
            })
            self.phase = "WORKER_RESENT"

    def record_cleanup_observations(self, *, owned_rows_zero, api_group_empty,
                                    worker_executor_settled, other_job_backends_zero,
                                    owner_observer_receipt_sha256):
        with self._operation("WORKER_RESENT"):
            require(owned_rows_zero is True and api_group_empty is True
                    and worker_executor_settled is True and other_job_backends_zero is True,
                    "B7 caller cleanup/settlement observations incomplete")
            sha(owner_observer_receipt_sha256)
            self._receipt("05-cleanup-observations.json", {
                "kind": "billing-B7-cleanup-observations", "usageEventId": self.event_id,
                "ownedRowsZero": True, "apiGroupEmpty": True, "workerExecutorSettled": True,
                "otherJobBackendsZero": True, "callerSuppliedObservations": True,
                "journalObservedDatabaseOrProcesses": False,
                "ownerObserverReceiptSha256": owner_observer_receipt_sha256,
                "ownerNativeQualificationRequired": True,
            })
            self.phase = "CLEANUP_OBSERVATIONS_RECORDED"

    def record_sequence_receipts_complete(self):
        with self._operation("CLEANUP_OBSERVATIONS_RECORDED"):
            self._receipt("06-sequence-not-terminal.json", {
                "kind": "billing-B7-sequence-receipts-complete", "usageEventId": self.event_id,
                "receipts": list(self.committed_receipts),
                "localSequenceReceiptsComplete": True,
                "nativeQualified": False, "ownerNativeQualificationRequired": True,
                "controllerExitAndExternalFinalReadbacksStillRequired": True,
                "successfulReleaseGate": False,
            })
            self.phase = "SEQUENCE_RECEIPTS_COMPLETE"

    def record_failure(self, code):
        with self._operation(allow_broken=True):
            require(code in FAILURE_CODES, "B7 failure code must be bounded and secret-free")
            require(self.phase != "FAILED", "B7 failure already recorded")
            failed_phase = self.phase
            self._receipt("99-failure.json", {
                "kind": "billing-B7-sequence-failed", "code": code, "failedPhase": failed_phase,
                "receipts": list(self.committed_receipts),
                "automaticRetryOrResume": False, "preserveDirectory": True,
                "operatorTerminalRecoveryRequired": True,
                "databaseAndProcessCleanupPerformedByJournal": False,
            })
            self.phase = "FAILED"
            self.broken = True

    def close(self):
        # Close only this object's descriptors. Retain the lock inode, phase
        # receipts, partial artifacts and directory. Never infer DB/process
        # cleanup, terminal qualification or deletion permission from close().
        if self.closed:
            return
        self.closed = True
        errors = []
        for field in ("lock_fd", "directory_fd", "parent_fd"):
            fd = getattr(self, field, None)
            if fd is not None:
                setattr(self, field, None)
                try:
                    os.close(fd)
                except OSError:
                    errors.append(field)
        require(not errors, "B7 owned descriptor close failed")
