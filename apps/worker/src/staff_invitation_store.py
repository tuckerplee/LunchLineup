from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import os
import random
import socket
from typing import Callable
import uuid


class GlobalClaimCapabilityError(RuntimeError):
    pass


class InvitationLeaseLostError(RuntimeError):
    pass


@dataclass(frozen=True)
class InvitationItem:
    id: str
    tenant_id: str
    user_id: str
    recipient_hash: str
    purpose: str
    encrypted_payload: bytes
    encryption_nonce: bytes
    encryption_tag: bytes
    encryption_key_ref: str
    payload_version: int
    attempts: int
    lease_owner: str


@dataclass(frozen=True)
class InvitationDiagnostics:
    due: int
    expired_leases: int
    dead_lettered: int
    recent_provider_failures: int
    last_dead_letter_unixtime: float
    last_provider_failure_unixtime: float


class PostgresInvitationStore:
    def __init__(
        self,
        database_url: str | None = None,
        *,
        max_attempts: int = 8,
        lease_seconds: int = 120,
        retry_base_seconds: int = 15,
        retry_max_seconds: int = 3600,
        retry_jitter_ratio: float = 0.25,
        diagnostics_count_cap: int = 1000,
        worker_id: str | None = None,
        now: Callable[[], datetime] | None = None,
        random_uniform: Callable[[float, float], float] | None = None,
    ):
        self.database_url = (database_url or os.getenv("DATABASE_URL", "")).strip()
        self.max_attempts = max_attempts
        self.lease_seconds = lease_seconds
        self.retry_base_seconds = retry_base_seconds
        self.retry_max_seconds = retry_max_seconds
        self.retry_jitter_ratio = retry_jitter_ratio
        self.diagnostics_count_cap = diagnostics_count_cap
        self.worker_id = worker_id or (
            f"staff-invitation/{socket.gethostname()}/{os.getpid()}/{uuid.uuid4().hex[:12]}"
        )
        self._now = now or (lambda: datetime.now(timezone.utc))
        self._random_uniform = random_uniform or random.uniform

    def _connect(self):
        import psycopg

        return psycopg.connect(self.database_url)

    def _enable_global_claims(self, cursor) -> None:
        capability = os.getenv("PLATFORM_ADMIN_DB_CONTEXT_SECRET", "").strip()
        if not capability:
            raise GlobalClaimCapabilityError(
                "platform capability is required for global staff invitation claims"
            )
        cursor.execute("SELECT set_current_platform_admin(true, %s)", (capability,))
        cursor.execute("SELECT is_current_platform_admin()")
        row = cursor.fetchone()
        if not row or row[0] is not True:
            raise GlobalClaimCapabilityError(
                "platform capability was not established for global staff invitation claims"
            )

    @staticmethod
    def _due_predicate(alias: str) -> str:
        return f'''(
            ({alias}."status" IN ('PENDING', 'FAILED') AND {alias}."retryAt" <= %s)
            OR ({alias}."status" = 'SENDING' AND {alias}."leaseExpiresAt" <= %s)
        )'''

    def claim_batch(self, limit: int) -> list[InvitationItem]:
        if limit < 1 or limit > 100:
            raise ValueError("staff invitation claim batch must be between 1 and 100")
        now = self._now()
        with self._connect() as connection, connection.cursor() as cursor:
            self._enable_global_claims(cursor)
            self._cancel_ineligible(cursor, now)
            self._dead_letter_suppressed(cursor, now)
            self._terminalize_exhausted_due(cursor, now)
            self._terminalize_expired_final_attempts(cursor, now)
            cursor.execute(f'''
                WITH due AS (
                    SELECT outbox."id"
                    FROM "StaffInvitationOutbox" AS outbox
                    JOIN "Tenant" AS tenant ON tenant."id" = outbox."tenantId"
                    JOIN "User" AS recipient
                      ON recipient."tenantId" = outbox."tenantId"
                     AND recipient."id" = outbox."userId"
                    WHERE {self._due_predicate("outbox")}
                      AND outbox."attempts" < %s
                      AND outbox."encryptedPayload" IS NOT NULL
                      AND recipient."deletedAt" IS NULL
                      AND recipient."suspendedAt" IS NULL
                      AND recipient."emailDeliverySuppressedAt" IS NULL
                      AND tenant."deletedAt" IS NULL
                      AND tenant."status" NOT IN ('SUSPENDED', 'CANCELLED', 'PURGED')
                    ORDER BY COALESCE(outbox."retryAt", outbox."leaseExpiresAt"),
                             outbox."createdAt", outbox."id"
                    FOR UPDATE OF outbox SKIP LOCKED
                    LIMIT %s
                )
                UPDATE "StaffInvitationOutbox" AS outbox
                SET "status" = 'SENDING',
                    "attempts" = outbox."attempts" + 1,
                    "retryAt" = NULL,
                    "leaseOwner" = %s,
                    "leaseExpiresAt" = %s,
                    "lastErrorCode" = NULL,
                    "updatedAt" = %s
                FROM due
                WHERE outbox."id" = due."id"
                RETURNING outbox."id", outbox."tenantId", outbox."userId",
                          outbox."recipientHash", outbox."purpose"::text,
                          outbox."encryptedPayload", outbox."encryptionNonce",
                          outbox."encryptionTag", outbox."encryptionKeyRef",
                          outbox."payloadVersion", outbox."attempts", outbox."leaseOwner"
            ''', (
                now,
                now,
                self.max_attempts,
                limit,
                self.worker_id,
                now + timedelta(seconds=self.lease_seconds),
                now,
            ))
            return [self._item(row) for row in cursor.fetchall()]

    def _cancel_ineligible(self, cursor, now: datetime) -> None:
        cursor.execute(f'''
            UPDATE "StaffInvitationOutbox" AS outbox
            SET "status" = 'CANCELLED',
                "cancelledAt" = %s,
                "lastErrorCode" = CASE
                    WHEN tenant."id" IS NULL OR tenant."deletedAt" IS NOT NULL
                      OR tenant."status" IN ('SUSPENDED', 'CANCELLED', 'PURGED')
                    THEN 'TENANT_LIFECYCLE_CHANGED'
                    ELSE 'USER_LIFECYCLE_CHANGED'
                END,
                "updatedAt" = %s
            FROM "User" AS recipient
            JOIN "Tenant" AS tenant ON tenant."id" = recipient."tenantId"
            WHERE recipient."tenantId" = outbox."tenantId"
              AND recipient."id" = outbox."userId"
              AND {self._due_predicate("outbox")}
              AND (
                recipient."deletedAt" IS NOT NULL
                OR recipient."suspendedAt" IS NOT NULL
                OR tenant."deletedAt" IS NOT NULL
                OR tenant."status" IN ('SUSPENDED', 'CANCELLED', 'PURGED')
              )
        ''', (now, now, now, now))

    def _dead_letter_suppressed(self, cursor, now: datetime) -> None:
        cursor.execute(f'''
            UPDATE "StaffInvitationOutbox" AS outbox
            SET "status" = 'DEAD_LETTERED',
                "deadLetteredAt" = %s,
                "lastErrorCode" = 'RECIPIENT_SUPPRESSED',
                "updatedAt" = %s
            FROM "User" AS recipient, "Tenant" AS tenant
            WHERE recipient."tenantId" = outbox."tenantId"
              AND recipient."id" = outbox."userId"
              AND tenant."id" = outbox."tenantId"
              AND {self._due_predicate("outbox")}
              AND recipient."deletedAt" IS NULL
              AND recipient."suspendedAt" IS NULL
              AND recipient."emailDeliverySuppressedAt" IS NOT NULL
              AND tenant."deletedAt" IS NULL
              AND tenant."status" NOT IN ('SUSPENDED', 'CANCELLED', 'PURGED')
        ''', (now, now, now, now))

    def _terminalize_expired_final_attempts(self, cursor, now: datetime) -> None:
        cursor.execute('''
            WITH expired AS (
                SELECT "id"
                FROM "StaffInvitationOutbox"
                WHERE "status" = 'SENDING'
                  AND "attempts" >= %s
                  AND "leaseExpiresAt" <= %s
                ORDER BY "leaseExpiresAt", "id"
                FOR UPDATE SKIP LOCKED
                LIMIT 100
            )
            UPDATE "StaffInvitationOutbox" AS outbox
            SET "status" = 'DEAD_LETTERED',
                "deadLetteredAt" = %s,
                "lastErrorCode" = 'FINAL_ATTEMPT_OUTCOME_UNKNOWN',
                "updatedAt" = %s
            FROM expired
            WHERE outbox."id" = expired."id"
        ''', (self.max_attempts, now, now, now))

    def _terminalize_exhausted_due(self, cursor, now: datetime) -> None:
        cursor.execute('''
            WITH exhausted AS (
                SELECT "id"
                FROM "StaffInvitationOutbox"
                WHERE "status" IN ('PENDING', 'FAILED')
                  AND "attempts" >= %s
                ORDER BY "retryAt", "createdAt", "id"
                FOR UPDATE SKIP LOCKED
                LIMIT 100
            )
            UPDATE "StaffInvitationOutbox" AS outbox
            SET "status" = 'DEAD_LETTERED',
                "deadLetteredAt" = %s,
                "lastErrorCode" = 'CONFIGURED_ATTEMPT_LIMIT_REACHED',
                "updatedAt" = %s
            FROM exhausted
            WHERE outbox."id" = exhausted."id"
        ''', (self.max_attempts, now, now))

    @staticmethod
    def _item(row) -> InvitationItem:
        return InvitationItem(
            id=str(row[0]),
            tenant_id=str(row[1]),
            user_id=str(row[2]),
            recipient_hash=str(row[3]),
            purpose=str(row[4]),
            encrypted_payload=bytes(row[5]),
            encryption_nonce=bytes(row[6]),
            encryption_tag=bytes(row[7]),
            encryption_key_ref=str(row[8]),
            payload_version=int(row[9]),
            attempts=int(row[10]),
            lease_owner=str(row[11]),
        )

    def deliver_if_eligible(
        self,
        item: InvitationItem,
        recipient_email: str,
        deliver: Callable[[], str],
    ) -> str:
        now = self._now()
        with self._connect() as connection, connection.cursor() as cursor:
            self._enable_global_claims(cursor)
            cursor.execute('SELECT "deletedAt", "status"::text FROM "Tenant" WHERE "id" = %s FOR UPDATE', (item.tenant_id,))
            tenant = cursor.fetchone()
            if not tenant or tenant[0] is not None or tenant[1] in ("SUSPENDED", "CANCELLED", "PURGED"):
                self._terminalize_owned(cursor, item, "CANCELLED", "TENANT_LIFECYCLE_CHANGED", now)
                return "cancelled"

            cursor.execute('''
                SELECT "deletedAt", "suspendedAt", "emailDeliverySuppressedAt",
                       lower("email") = lower(%s)
                FROM "User"
                WHERE "tenantId" = %s AND "id" = %s
                FOR UPDATE
            ''', (recipient_email, item.tenant_id, item.user_id))
            recipient = cursor.fetchone()
            if (
                not recipient
                or recipient[0] is not None
                or recipient[1] is not None
                or not recipient[3]
            ):
                self._terminalize_owned(cursor, item, "CANCELLED", "USER_LIFECYCLE_CHANGED", now)
                return "cancelled"
            if recipient[2] is not None:
                self._terminalize_owned(cursor, item, "DEAD_LETTERED", "RECIPIENT_SUPPRESSED", now)
                return "suppressed"

            cursor.execute('''
                SELECT 1
                FROM "StaffInvitationOutbox"
                WHERE "id" = %s
                  AND "status" = 'SENDING'
                  AND "attempts" = %s
                  AND "leaseOwner" = %s
                  AND "leaseExpiresAt" > %s
                FOR UPDATE
            ''', (item.id, item.attempts, item.lease_owner, now))
            if not cursor.fetchone():
                raise InvitationLeaseLostError("staff invitation lease was lost before provider handoff")

            provider_message_id = deliver()
            cursor.execute('''
                UPDATE "StaffInvitationOutbox"
                SET "status" = 'DELIVERED',
                    "providerMessageId" = %s,
                    "deliveredAt" = %s,
                    "lastErrorCode" = NULL,
                    "updatedAt" = %s
                WHERE "id" = %s
                  AND "status" = 'SENDING'
                  AND "attempts" = %s
                  AND "leaseOwner" = %s
            ''', (provider_message_id, now, now, item.id, item.attempts, item.lease_owner))
            if cursor.rowcount != 1:
                raise InvitationLeaseLostError("staff invitation lease was lost after provider handoff")
            return "delivered"

    def _terminalize_owned(
        self,
        cursor,
        item: InvitationItem,
        status: str,
        error_code: str,
        now: datetime,
    ) -> None:
        terminal_column = "cancelledAt" if status == "CANCELLED" else "deadLetteredAt"
        cursor.execute(f'''
            UPDATE "StaffInvitationOutbox"
            SET "status" = %s,
                "{terminal_column}" = %s,
                "lastErrorCode" = %s,
                "updatedAt" = %s
            WHERE "id" = %s
              AND "status" = 'SENDING'
              AND "attempts" = %s
              AND "leaseOwner" = %s
        ''', (status, now, error_code, now, item.id, item.attempts, item.lease_owner))
        if cursor.rowcount != 1:
            raise InvitationLeaseLostError("staff invitation lease was lost during terminal transition")

    def mark_failed(self, item: InvitationItem, error_code: str, terminal: bool) -> None:
        now = self._now()
        status = "DEAD_LETTERED" if terminal else "FAILED"
        retry_at = None if terminal else now + timedelta(seconds=self._retry_delay(item.attempts))
        with self._connect() as connection, connection.cursor() as cursor:
            self._enable_global_claims(cursor)
            cursor.execute('''
                UPDATE "StaffInvitationOutbox"
                SET "status" = %s,
                    "retryAt" = %s,
                    "deadLetteredAt" = %s,
                    "leaseOwner" = NULL,
                    "leaseExpiresAt" = NULL,
                    "lastErrorCode" = %s,
                    "updatedAt" = %s
                WHERE "id" = %s
                  AND "status" = 'SENDING'
                  AND "attempts" = %s
                  AND "leaseOwner" = %s
            ''', (
                status,
                retry_at,
                now if terminal else None,
                error_code,
                now,
                item.id,
                item.attempts,
                item.lease_owner,
            ))
            if cursor.rowcount != 1:
                raise InvitationLeaseLostError("staff invitation lease was lost before failure transition")

    def _retry_delay(self, attempts: int) -> float:
        base = min(self.retry_max_seconds, self.retry_base_seconds * (2 ** max(0, attempts - 1)))
        jitter = base * self.retry_jitter_ratio
        return max(1.0, self._random_uniform(base - jitter, base + jitter))

    def diagnostics(self, provider_window_seconds: int) -> InvitationDiagnostics:
        now = self._now()
        since = now - timedelta(seconds=provider_window_seconds)
        cap = self.diagnostics_count_cap
        with self._connect() as connection, connection.cursor() as cursor:
            self._enable_global_claims(cursor)
            cursor.execute('''
                SELECT
                  (SELECT COUNT(*) FROM (
                    SELECT 1 FROM "StaffInvitationOutbox"
                    WHERE "status" IN ('PENDING', 'FAILED') AND "retryAt" <= %s LIMIT %s
                  ) AS due),
                  (SELECT COUNT(*) FROM (
                    SELECT 1 FROM "StaffInvitationOutbox"
                    WHERE "status" = 'SENDING' AND "leaseExpiresAt" <= %s LIMIT %s
                  ) AS expired),
                  (SELECT COUNT(*) FROM (
                    SELECT 1 FROM "StaffInvitationOutbox"
                    WHERE "status" = 'DEAD_LETTERED' LIMIT %s
                  ) AS dead),
                  (SELECT COUNT(*) FROM (
                    SELECT 1 FROM "StaffInvitationOutbox"
                    WHERE "updatedAt" >= %s
                      AND "lastErrorCode" IN ('PROVIDER_RETRYABLE', 'PROVIDER_REJECTED')
                    LIMIT %s
                  ) AS provider_failures),
                  COALESCE((SELECT EXTRACT(EPOCH FROM MAX("deadLetteredAt"))
                    FROM "StaffInvitationOutbox" WHERE "status" = 'DEAD_LETTERED'), 0),
                  COALESCE((SELECT EXTRACT(EPOCH FROM MAX("updatedAt"))
                    FROM "StaffInvitationOutbox" WHERE "updatedAt" >= %s
                      AND "lastErrorCode" IN ('PROVIDER_RETRYABLE', 'PROVIDER_REJECTED')), 0)
            ''', (now, cap, now, cap, cap, since, cap, since))
            row = cursor.fetchone()
            return InvitationDiagnostics(
                due=int(row[0]),
                expired_leases=int(row[1]),
                dead_lettered=int(row[2]),
                recent_provider_failures=int(row[3]),
                last_dead_letter_unixtime=float(row[4]),
                last_provider_failure_unixtime=float(row[5]),
            )
