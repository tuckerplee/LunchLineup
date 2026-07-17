"""Tenant-scoped persistence and lifecycle ownership for availability imports."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
import json
import os
from pathlib import Path
import re
from typing import Any


ID_RE = re.compile(r"^[A-Za-z0-9._:@+-]{1,128}$")
HASH_RE = re.compile(r"^[a-f0-9]{64}$")
STORAGE_KEY_RE = re.compile(r"^[a-f0-9-]{36}\.pdf$", re.IGNORECASE)
TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "DEAD_LETTERED", "CANCELLED"}
ENCRYPTED_SOURCE_MAGIC = b"LLAI"
MIN_AAD_BOUND_ENVELOPE_VERSION = 3


class AvailabilityImportRejected(RuntimeError):
    pass


class AvailabilityImportRetryable(RuntimeError):
    def __init__(self, message: str, payload: "ImportPayload", execution_token: str | None = None):
        super().__init__(message)
        self.payload = payload
        self.execution_token = execution_token


class AvailabilityImportBusy(RuntimeError):
    pass


@dataclass(frozen=True)
class ImportPayload:
    import_id: str
    tenant_id: str


@dataclass(frozen=True)
class ClaimedImport:
    payload: ImportPayload
    execution_token: str
    path: Path | None
    file_sha256: str
    file_size: int
    status: str
    encrypted_source_payload: bytes | None = None
    request_identity_hash: str = ""
    target_identity_hash: str = ""


@dataclass(frozen=True)
class LockedImportState:
    status: str
    storage_key: str | None
    file_sha256: str
    file_size: int
    encrypted_source_payload: bytes | None
    credit_consumption: Any
    execution_token: str | None
    lease_active: bool | None
    request_identity_hash: str
    target_identity_hash: str
    user_id: str
    unexpired: bool
    debit_count: int
    debit_tenant_id: str | None
    debit_amount: int | None
    debit_reason: str | None
    debit_balance_after: int | None
    refund_count: int
    refund_tenant_id: str | None
    refund_amount: int | None
    refund_reason: str | None
    refund_balance_after: int | None


def validate_import_payload(raw: Any) -> ImportPayload:
    if not isinstance(raw, dict) or set(raw) != {"import_id", "tenant_id"}:
        raise AvailabilityImportRejected("availability import payload failed validation")
    import_id = raw.get("import_id")
    tenant_id = raw.get("tenant_id")
    if not isinstance(import_id, str) or not ID_RE.fullmatch(import_id):
        raise AvailabilityImportRejected("availability import payload failed validation")
    if not isinstance(tenant_id, str) or not ID_RE.fullmatch(tenant_id):
        raise AvailabilityImportRejected("availability import payload failed validation")
    return ImportPayload(import_id=import_id, tenant_id=tenant_id)


def claim_import(payload: ImportPayload, retry_count: int, token: str) -> ClaimedImport:
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_current_tenant(%s)", (payload.tenant_id,))
            tenant = _lock_tenant(cursor, payload.tenant_id)
            preview = _preview_job_owner(cursor, payload)
            if preview is None:
                raise AvailabilityImportRejected("availability import not found or expired")
            if preview[0] in TERMINAL_STATUSES:
                state = _lock_job(cursor, payload)
                if state is not None and state.status in TERMINAL_STATUSES:
                    return ClaimedImport(payload, token, Path(), "", 0, "terminal")

            target = _lock_active_target(cursor, payload.tenant_id, preview[1])
            state = _lock_job(cursor, payload)
            if state is None or state.user_id != preview[1]:
                raise AvailabilityImportRejected("availability import ownership changed")
            if state.status in TERMINAL_STATUSES:
                return ClaimedImport(payload, token, Path(), "", 0, "terminal")
            if not state.unexpired:
                raise AvailabilityImportRejected("availability import not found or expired")
            if target is None:
                raise AvailabilityImportRejected("availability import target is not active")
            if not _tenant_is_paid_active(tenant):
                raise AvailabilityImportRejected("availability import requires an active paid subscription")
            if not _has_paid_credit_reservation(state, payload):
                raise AvailabilityImportRejected("availability import is missing its paid credit reservation")
            if state.status == "RUNNING" and state.lease_active and state.execution_token != token:
                raise AvailabilityImportBusy("availability import already has an active execution owner")

            path = None
            if state.storage_key:
                try:
                    path = resolve_storage_key(state.storage_key)
                except AvailabilityImportRejected:
                    path = None
            cursor.execute(
                """
                UPDATE "AvailabilityImportJob"
                SET "status" = 'RUNNING',
                    "attempts" = %s,
                    "executionToken" = %s,
                    "executionLeaseUntil" = CURRENT_TIMESTAMP + INTERVAL '60 seconds',
                    "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
                    "failureCode" = NULL,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "tenantId" = %s
                  AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
                """,
                (retry_count + 1, token, payload.import_id, payload.tenant_id),
            )
            if cursor.rowcount != 1:
                raise AvailabilityImportRejected("availability import execution ownership changed")
            return ClaimedImport(
                payload,
                token,
                path,
                state.file_sha256,
                state.file_size,
                "claimed",
                state.encrypted_source_payload,
                state.request_identity_hash,
                state.target_identity_hash,
            )


def complete_import(
    payload: ImportPayload,
    token: str,
    source_identity_hash: str,
    availability: list[dict[str, int | None]],
) -> None:
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_current_tenant(%s)", (payload.tenant_id,))
            tenant = _lock_tenant(cursor, payload.tenant_id)
            preview = _preview_job_owner(cursor, payload)
            if preview is None:
                raise AvailabilityImportRejected("availability import no longer exists")
            target = _lock_active_target(cursor, payload.tenant_id, preview[1])
            state = _lock_job(cursor, payload)
            if state is None or state.user_id != preview[1]:
                raise AvailabilityImportRejected("availability import ownership changed")
            if state.status != "RUNNING" or state.execution_token != token:
                raise AvailabilityImportRejected("availability import execution ownership changed")
            if not state.unexpired:
                raise AvailabilityImportRejected("availability import expired before completion")
            if target is None:
                raise AvailabilityImportRejected("availability import target is not active")
            if not _tenant_is_paid_active(tenant):
                raise AvailabilityImportRejected("availability import requires an active paid subscription")
            expected_identity_hash = _expected_source_identity_hash(state)
            if not HASH_RE.fullmatch(source_identity_hash) or source_identity_hash != expected_identity_hash:
                raise AvailabilityImportRejected("availability import target identity did not match the document")
            if not _has_paid_credit_reservation(state, payload):
                raise AvailabilityImportRejected("availability import is missing its paid credit reservation")

            cursor.execute(
                """
                UPDATE "AvailabilityImportJob"
                SET "status" = 'SUCCEEDED',
                    "parsedAvailability" = %s::jsonb,
                    "storageKey" = NULL,
                    "encryptedSourcePayload" = NULL,
                    "resultErasedAt" = NULL,
                    "failureCode" = NULL,
                    "executionToken" = NULL,
                    "executionLeaseUntil" = NULL,
                    "completedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "tenantId" = %s
                  AND "status" = 'RUNNING' AND "executionToken" = %s
                """,
                (
                    json.dumps(availability, separators=(",", ":")),
                    payload.import_id,
                    payload.tenant_id,
                    token,
                ),
            )
            if cursor.rowcount != 1:
                raise AvailabilityImportRejected("availability import execution ownership changed")


def mark_retrying(
    payload: ImportPayload,
    token: str | None,
    retry_count: int,
) -> None:
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_current_tenant(%s)", (payload.tenant_id,))
            cursor.execute(
                """
                SELECT
                    "status",
                    "executionToken",
                    "executionLeaseUntil" > CURRENT_TIMESTAMP
                FROM "AvailabilityImportJob"
                WHERE "id" = %s AND "tenantId" = %s
                """,
                (payload.import_id, payload.tenant_id),
            )
            owner = cursor.fetchone()
            if owner is None or str(owner[0]) in TERMINAL_STATUSES:
                return
            execution_token = str(owner[1]) if owner[1] is not None else None
            lease_active = bool(owner[2]) if owner[2] is not None else None
            owns_retry_handoff = (
                execution_token is None or lease_active is False
                if token is None
                else execution_token == token
            )
            if not owns_retry_handoff:
                raise AvailabilityImportBusy("availability import already has an active execution owner")
            cursor.execute(
                """
                UPDATE "AvailabilityImportJob"
                SET "status" = 'RETRYING',
                    "attempts" = %s,
                    "executionToken" = NULL,
                    "executionLeaseUntil" = NULL,
                    "failureCode" = 'TRANSIENT_FAILURE',
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "tenantId" = %s
                  AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
                  AND CASE
                      WHEN %s IS NULL THEN
                          "executionToken" IS NULL
                          OR "executionLeaseUntil" <= CURRENT_TIMESTAMP
                      ELSE "executionToken" = %s
                  END
                """,
                (retry_count, payload.import_id, payload.tenant_id, token, token),
            )
            if cursor.rowcount != 1:
                raise AvailabilityImportBusy("availability import retry ownership changed")


def terminalize_import(
    payload: ImportPayload,
    token: str | None,
    status: str,
    failure_code: str,
) -> Path | None:
    if status not in {"FAILED", "DEAD_LETTERED"}:
        raise ValueError("invalid terminal availability import status")
    source_path: Path | None = None
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_current_tenant(%s)", (payload.tenant_id,))
            _lock_tenant(cursor, payload.tenant_id)
            state = _lock_job(cursor, payload)
            if state is None:
                return None
            if state.status in TERMINAL_STATUSES:
                if state.status in {"FAILED", "DEAD_LETTERED"}:
                    _authoritative_refund_amount(state, payload, require_existing=True)
                return None
            if token is None:
                owns_execution = state.execution_token is None or state.lease_active is False
            else:
                owns_execution = state.execution_token == token
            if not owns_execution:
                raise AvailabilityImportRejected("availability import execution ownership changed")
            if state.storage_key:
                try:
                    source_path = resolve_storage_key(state.storage_key)
                except AvailabilityImportRejected:
                    source_path = None
            refund_amount = _authoritative_refund_amount(
                state,
                payload,
                require_existing=False,
            )
            refund_id = f"feature-refund-availability-import:{payload.import_id}"
            cursor.execute(
                'UPDATE "Tenant" SET "usageCredits" = "usageCredits" + %s, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = %s RETURNING "usageCredits"',
                (refund_amount, payload.tenant_id),
            )
            wallet_row = cursor.fetchone()
            if wallet_row is None or not _is_nonnegative_int(wallet_row[0]):
                raise AvailabilityImportRejected("availability import refund wallet settlement failed")
            refund_balance_after = int(wallet_row[0])
            cursor.execute(
                """
                INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "balanceAfter", "createdAt")
                VALUES (%s, %s, %s, %s, %s, CURRENT_TIMESTAMP)
                ON CONFLICT ("id") DO NOTHING
                RETURNING "id"
                """,
                (
                    refund_id,
                    payload.tenant_id,
                    refund_amount,
                    f"Availability PDF import refund ({payload.import_id})",
                    refund_balance_after,
                ),
            )
            if cursor.fetchone() is None:
                raise AvailabilityImportRejected("availability import refund settlement conflicted")
            cursor.execute(
                """
                UPDATE "AvailabilityImportJob"
                SET "status" = %s,
                    "parsedAvailability" = NULL,
                    "resultErasedAt" = CURRENT_TIMESTAMP,
                    "failureCode" = %s,
                    "storageKey" = NULL,
                    "encryptedSourcePayload" = NULL,
                    "executionToken" = NULL,
                    "executionLeaseUntil" = NULL,
                    "completedAt" = CURRENT_TIMESTAMP,
                    "updatedAt" = CURRENT_TIMESTAMP
                WHERE "id" = %s AND "tenantId" = %s
                  AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
                  AND CASE
                      WHEN %s IS NULL THEN
                          "executionToken" IS NULL
                          OR "executionLeaseUntil" <= CURRENT_TIMESTAMP
                      ELSE "executionToken" = %s
                  END
                """,
                (
                    status,
                    failure_code,
                    payload.import_id,
                    payload.tenant_id,
                    token,
                    token,
                ),
            )
            if cursor.rowcount != 1:
                raise AvailabilityImportRejected("availability import execution ownership changed")
    return source_path


def cleanup_source(payload: ImportPayload, path: Path | None) -> None:
    try:
        if path is not None:
            path.unlink(missing_ok=True)
    finally:
        try:
            with _connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT set_current_tenant(%s)", (payload.tenant_id,))
                    cursor.execute(
                        'UPDATE "AvailabilityImportJob" SET "storageKey" = NULL, "encryptedSourcePayload" = NULL, "updatedAt" = CURRENT_TIMESTAMP WHERE "id" = %s AND "tenantId" = %s',
                        (payload.import_id, payload.tenant_id),
                    )
        except Exception:
            # The opaque key contains no user data; the API orphan sweep still removes the file.
            pass


def resolve_storage_key(storage_key: str) -> Path:
    if not STORAGE_KEY_RE.fullmatch(storage_key):
        raise AvailabilityImportRejected("availability import storage reference is invalid")
    root = Path(os.getenv("WORKER_UPLOAD_ROOT", "/app/uploads")).resolve()
    candidate = (root / storage_key).resolve()
    if candidate.parent != root:
        raise AvailabilityImportRejected("availability import storage reference is invalid")
    return candidate


async def run_availability_import_retention_loop() -> None:
    interval = _bounded_float(
        "WORKER_AVAILABILITY_RETENTION_INTERVAL_SECONDS",
        300.0,
        30.0,
        3600.0,
    )
    while True:
        try:
            await asyncio.to_thread(sweep_expired_imports)
        except asyncio.CancelledError:
            raise
        except Exception:
            # The next bounded sweep retries; queue processing must remain available.
            pass
        await asyncio.sleep(interval)


def sweep_expired_imports() -> int:
    capability = os.getenv("PLATFORM_ADMIN_DB_CONTEXT_SECRET", "").strip()
    if not capability:
        return 0
    batch_size = int(_bounded_float("WORKER_AVAILABILITY_RETENTION_BATCH_SIZE", 50, 1, 200))
    with _connect() as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_current_platform_admin(true, %s)", (capability,))
            cursor.execute(
                """
                SELECT "id", "tenantId", "storageKey", "status"
                FROM "AvailabilityImportJob"
                WHERE (
                    "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
                    AND "expiresAt" <= CURRENT_TIMESTAMP
                ) OR (
                    "status" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
                    AND "completedAt" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
                    AND (
                        "parsedAvailability" IS NOT NULL
                        OR "storageKey" IS NOT NULL
                        OR "encryptedSourcePayload" IS NOT NULL
                        OR "resultErasedAt" IS NULL
                    )
                )
                ORDER BY COALESCE("completedAt", "expiresAt"), "id"
                LIMIT %s
                FOR UPDATE SKIP LOCKED
                """,
                (batch_size,),
            )
            rows = cursor.fetchall()
    for import_id, tenant_id, storage_key, status in rows:
        payload = ImportPayload(str(import_id), str(tenant_id))
        path = None
        if storage_key:
            try:
                path = resolve_storage_key(str(storage_key))
            except AvailabilityImportRejected:
                path = None
        if str(status) not in TERMINAL_STATUSES:
            terminal_path = terminalize_import(payload, None, "FAILED", "EXPIRED")
            path = terminal_path or path
        if path is not None:
            cleanup_source(payload, path)
        with _connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (payload.tenant_id,))
                cursor.execute(
                    """
                    UPDATE "AvailabilityImportJob"
                    SET "parsedAvailability" = NULL,
                        "storageKey" = NULL,
                        "resultErasedAt" = COALESCE("resultErasedAt", CURRENT_TIMESTAMP),
                        "encryptedSourcePayload" = NULL,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s AND "tenantId" = %s
                      AND "status" IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED', 'CANCELLED')
                      AND "completedAt" <= CURRENT_TIMESTAMP - INTERVAL '24 hours'
                    """,
                    (payload.import_id, payload.tenant_id),
                )
    return len(rows)


def _lock_tenant(
    cursor: Any,
    tenant_id: str,
) -> tuple[str, str, str | None, Any, bool | None] | None:
    cursor.execute(
        'SELECT "status", "planTier", "stripeSubscriptionId", "stripeSubscriptionCurrentPeriodEnd", '
        '"stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP '
        'FROM "Tenant" WHERE "id" = %s FOR UPDATE',
        (tenant_id,),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return (
        str(row[0]),
        str(row[1]),
        str(row[2]) if row[2] is not None else None,
        row[3],
        bool(row[4]) if row[4] is not None else None,
    )


def _preview_job_owner(cursor: Any, payload: ImportPayload) -> tuple[str, str] | None:
    cursor.execute(
        'SELECT "status", "userId" FROM "AvailabilityImportJob" WHERE "id" = %s AND "tenantId" = %s',
        (payload.import_id, payload.tenant_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return str(row[0]), str(row[1])


def _lock_active_target(
    cursor: Any,
    tenant_id: str,
    user_id: str,
) -> str | None:
    cursor.execute(
        """
        SELECT "id"
        FROM "User"
        WHERE "id" = %s
          AND "tenantId" = %s
          AND "role" IN ('MANAGER', 'STAFF')
          AND "deletedAt" IS NULL
          AND "suspendedAt" IS NULL
        FOR UPDATE
        """,
        (user_id, tenant_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return str(row[0])


def _lock_job(cursor: Any, payload: ImportPayload) -> LockedImportState | None:
    cursor.execute(
        """
        SELECT
            job."status",
            job."storageKey",
            job."fileSha256",
            job."fileSize",
            job."encryptedSourcePayload",
            job."creditConsumption",
            job."executionToken",
            job."executionLeaseUntil" > CURRENT_TIMESTAMP,
            job."requestHash",
            job."targetIdentityHash",
            job."userId",
            job."expiresAt" > CURRENT_TIMESTAMP,
            (
                SELECT COUNT(*)::integer FROM "CreditTransaction" credit
                WHERE credit."id" = 'feature-usage-availability-import:' || job."id"
            ) AS "debitCount",
            (
                SELECT MIN(credit."tenantId") FROM "CreditTransaction" credit
                WHERE credit."id" = 'feature-usage-availability-import:' || job."id"
            ) AS "debitTenantId",
            (
                SELECT MIN(credit."amount") FROM "CreditTransaction" credit
                WHERE credit."id" = 'feature-usage-availability-import:' || job."id"
            ) AS "debitAmount",
            (
                SELECT MIN(credit."reason") FROM "CreditTransaction" credit
                WHERE credit."id" = 'feature-usage-availability-import:' || job."id"
            ) AS "debitReason",
            (
                SELECT MIN(credit."balanceAfter") FROM "CreditTransaction" credit
                WHERE credit."id" = 'feature-usage-availability-import:' || job."id"
            ) AS "debitBalanceAfter",
            (
                SELECT COUNT(*)::integer FROM "CreditTransaction" refund
                WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
            ) AS "refundCount",
            (
                SELECT MIN(refund."tenantId") FROM "CreditTransaction" refund
                WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
            ) AS "refundTenantId",
            (
                SELECT MIN(refund."amount") FROM "CreditTransaction" refund
                WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
            ) AS "refundAmount",
            (
                SELECT MIN(refund."reason") FROM "CreditTransaction" refund
                WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
            ) AS "refundReason",
            (
                SELECT MIN(refund."balanceAfter") FROM "CreditTransaction" refund
                WHERE refund."id" = 'feature-refund-availability-import:' || job."id"
            ) AS "refundBalanceAfter"
        FROM "AvailabilityImportJob" job
        WHERE job."id" = %s
          AND job."tenantId" = %s
        FOR UPDATE OF job
        """,
        (payload.import_id, payload.tenant_id),
    )
    row = cursor.fetchone()
    if not row:
        return None
    return LockedImportState(
        status=str(row[0]),
        storage_key=str(row[1]) if row[1] is not None else None,
        file_sha256=str(row[2]),
        file_size=int(row[3]),
        encrypted_source_payload=bytes(row[4]) if row[4] is not None else None,
        credit_consumption=row[5],
        execution_token=str(row[6]) if row[6] is not None else None,
        lease_active=bool(row[7]) if row[7] is not None else None,
        request_identity_hash=str(row[8] or ""),
        target_identity_hash=str(row[9] or ""),
        user_id=str(row[10]),
        unexpired=bool(row[11]),
        debit_count=int(row[12]),
        debit_tenant_id=str(row[13]) if row[13] is not None else None,
        debit_amount=int(row[14]) if row[14] is not None else None,
        debit_reason=str(row[15]) if row[15] is not None else None,
        debit_balance_after=int(row[16]) if row[16] is not None else None,
        refund_count=int(row[17]),
        refund_tenant_id=str(row[18]) if row[18] is not None else None,
        refund_amount=int(row[19]) if row[19] is not None else None,
        refund_reason=str(row[20]) if row[20] is not None else None,
        refund_balance_after=int(row[21]) if row[21] is not None else None,
    )


def _tenant_is_paid_active(
    tenant: tuple[str, str, str | None, Any, bool | None] | None,
) -> bool:
    return (
        tenant is not None
        and tenant[0] == "ACTIVE"
        and tenant[1].strip().upper() != "FREE"
        and bool((tenant[2] or "").strip())
        and tenant[3] is not None
        and tenant[4] is True
    )


def _expected_source_identity_hash(state: LockedImportState) -> str:
    envelope = state.encrypted_source_payload
    if (
        envelope is not None
        and len(envelope) >= len(ENCRYPTED_SOURCE_MAGIC) + 1
        and envelope[: len(ENCRYPTED_SOURCE_MAGIC)] == ENCRYPTED_SOURCE_MAGIC
        and envelope[len(ENCRYPTED_SOURCE_MAGIC)] >= MIN_AAD_BOUND_ENVELOPE_VERSION
    ):
        return state.request_identity_hash
    return state.target_identity_hash


def _has_paid_credit_reservation(state: LockedImportState, payload: ImportPayload) -> bool:
    return (
        _debit_is_exact(state)
        and state.debit_tenant_id == payload.tenant_id
        and state.debit_reason == f"Availability PDF import ({payload.import_id})"
        and state.refund_count == 0
    )


def _debit_is_exact(state: LockedImportState) -> bool:
    configured_amount = _consumed_credits(state.credit_consumption)
    configured_balance = _settlement_new_balance(state.credit_consumption)
    return (
        configured_amount > 0
        and configured_balance is not None
        and state.debit_count == 1
        and state.debit_tenant_id is not None
        and state.debit_amount == -configured_amount
        and state.debit_reason is not None
        and state.debit_balance_after == configured_balance
    )


def _authoritative_refund_amount(
    state: LockedImportState,
    payload: ImportPayload,
    *,
    require_existing: bool,
) -> int:
    expected_debit_reason = f"Availability PDF import ({payload.import_id})"
    if (
        not _debit_is_exact(state)
        or state.debit_tenant_id != payload.tenant_id
        or state.debit_reason != expected_debit_reason
        or state.debit_amount is None
    ):
        raise AvailabilityImportRejected("availability import debit provenance check failed")

    refund_amount = -state.debit_amount
    if require_existing:
        if (
            state.refund_count != 1
            or state.refund_tenant_id != payload.tenant_id
            or state.refund_amount != refund_amount
            or state.refund_reason != f"Availability PDF import refund ({payload.import_id})"
            or not _is_nonnegative_int(state.refund_balance_after)
        ):
            raise AvailabilityImportRejected("availability import refund provenance check failed")
    elif state.refund_count != 0:
        raise AvailabilityImportRejected("availability import refund provenance check failed")
    return refund_amount


def _consumed_credits(value: Any) -> int:
    if isinstance(value, str):
        value = json.loads(value)
    consumed = value.get("consumedCredits") if isinstance(value, dict) else None
    if isinstance(consumed, bool) or not isinstance(consumed, int) or consumed <= 0:
        return 0
    return consumed


def _settlement_new_balance(value: Any) -> int | None:
    if isinstance(value, str):
        value = json.loads(value)
    balance = value.get("newBalance") if isinstance(value, dict) else None
    return int(balance) if _is_nonnegative_int(balance) else None


def _is_nonnegative_int(value: Any) -> bool:
    return isinstance(value, int) and not isinstance(value, bool) and value >= 0


def _database_url() -> str:
    value = os.getenv("DATABASE_URL", "").strip()
    if not value:
        raise RuntimeError("DATABASE_URL is required for availability imports")
    return value


def _connect():
    try:
        import psycopg
    except ImportError as exc:
        raise RuntimeError("psycopg is required for availability imports") from exc
    return psycopg.connect(_database_url())


def _bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))
