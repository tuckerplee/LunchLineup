from __future__ import annotations

import asyncio
import base64
from collections import deque
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import html
import json
import logging
import os
import time
from typing import Callable, Protocol
from urllib import error, request

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from prometheus_client import Counter, Gauge

logger = logging.getLogger("worker.password_reset_email")
ERASED_ENCRYPTED_PAYLOAD = ""
ERASED_ENCRYPTION_KEY_REF = "erased-v1"
DELIVERY_TOTAL = Counter("lunchlineup_password_reset_email_total", "Password reset email outbox outcomes", ["status"])
DEAD_LETTERED = Gauge("lunchlineup_password_reset_email_dead_lettered", "Password reset emails requiring operator attention")
SWEEP_FAILURES = Counter(
    "lunchlineup_password_reset_email_sweep_failures_total",
    "Password reset email sweeps that failed before completion",
)
SWEEP_RUNNING = Gauge(
    "lunchlineup_password_reset_email_sweep_running",
    "Whether the password reset email sweep task is running",
)
SWEEP_READY = Gauge(
    "lunchlineup_password_reset_email_sweep_ready",
    "Whether the password reset email sweep most recently completed successfully",
)
SWEEP_LAST_SUCCESS = Gauge(
    "lunchlineup_password_reset_email_sweep_last_success_unixtime",
    "Unix time of the last successful password reset email sweep",
)
SWEEP_PROVIDER_FAILURES = Counter(
    "lunchlineup_password_reset_email_provider_failures_total",
    "Password reset provider failures by retryability",
    ["kind"],
)
SWEEP_RECENT_PROVIDER_FAILURES = Gauge(
    "lunchlineup_password_reset_email_recent_provider_failures",
    "Durable provider failures inside the bounded health window",
)
SWEEP_SYSTEMIC_PROVIDER_FAILURE = Gauge(
    "lunchlineup_password_reset_email_systemic_provider_failure",
    "Whether recent provider failures meet the systemic outage threshold",
)
SWEEP_LAST_PROVIDER_FAILURE = Gauge(
    "lunchlineup_password_reset_email_last_provider_failure_unixtime",
    "Unix time of the most recently observed provider failure",
)
SWEEP_LAST_DEAD_LETTER = Gauge(
    "lunchlineup_password_reset_email_last_dead_letter_unixtime",
    "Unix time of the most recently observed password reset dead letter",
)


class RetryableEmailError(RuntimeError):
    pass


class NonRetryableEmailError(RuntimeError):
    pass


class ProviderEmailFailure:
    """Marker for bounded provider health accounting."""


class RetryableProviderEmailError(RetryableEmailError, ProviderEmailFailure):
    pass


class ProviderRejectedEmailError(NonRetryableEmailError, ProviderEmailFailure):
    pass


class LifecycleBlockedEmailError(NonRetryableEmailError):
    pass


class OutboxLeaseLostError(RetryableEmailError):
    pass


class ProviderFailureWindow:
    """Bounded process-local fallback for provider diagnostics erased at terminal state."""

    def __init__(
        self,
        clock: Callable[[], float] = time.time,
        max_events: int = 10_000,
    ):
        self._clock = clock
        self._events: deque[float] = deque(maxlen=max_events)

    def record(self) -> None:
        self._events.append(self._clock())

    def recent(self, window_seconds: int) -> tuple[int, float]:
        now = self._clock()
        cutoff = now - window_seconds
        while self._events and self._events[0] < cutoff:
            self._events.popleft()
        return len(self._events), self._events[-1] if self._events else 0.0


def password_reset_failure_code(exc: Exception, terminal: bool) -> str:
    if isinstance(exc, ProviderEmailFailure):
        return (
            "PASSWORD_RESET_EMAIL_PROVIDER_REJECTED" if terminal
            else "PASSWORD_RESET_EMAIL_PROVIDER_RETRYABLE"
        )
    if isinstance(exc, NonRetryableEmailError):
        return "PASSWORD_RESET_EMAIL_NON_RETRYABLE"
    if terminal:
        return "PASSWORD_RESET_EMAIL_RETRIES_EXHAUSTED"
    return "PASSWORD_RESET_EMAIL_RETRYABLE"


@dataclass(frozen=True)
class ResetEmail:
    id: str
    tenant_id: str
    user_id: str
    encrypted_payload: str
    encryption_key_ref: str
    attempts: int


class ResetEmailStore(Protocol):
    def claim(self, outbox_id: str | None = None) -> ResetEmail | None: ...
    def deliver_if_eligible(
        self,
        item: ResetEmail,
        email: str,
        deliver: Callable[[], None],
    ) -> bool: ...
    def mark_delivered(self, item: ResetEmail) -> None: ...
    def mark_failed(self, item: ResetEmail, message: str, terminal: bool) -> None: ...
    def dead_lettered_count(self) -> int: ...
    def last_dead_letter_unixtime(self) -> float: ...
    def recent_provider_failures(self, window_seconds: int) -> tuple[int, float]: ...
    def terminalize_stranded(self) -> int: ...


def int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def password_reset_email_enabled() -> bool:
    return os.getenv("PASSWORD_RESET_EMAIL_OUTBOX_ENABLED", "false").strip().lower() == "true"


def validate_password_reset_email_config() -> None:
    if not password_reset_email_enabled():
        return
    for key in ("DATABASE_URL", "PLATFORM_ADMIN_DB_CONTEXT_SECRET", "PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY", "RESEND_API_KEY", "EMAIL_FROM"):
        if not os.getenv(key, "").strip():
            raise RuntimeError(f"{key} is required when password reset email outbox delivery is enabled")
    encryption_key()


def encryption_key() -> bytes:
    configured = os.getenv("PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY", "").strip()
    try:
        key = bytes.fromhex(configured) if len(configured) == 64 else base64.b64decode(configured, validate=True)
    except (ValueError, TypeError) as exc:
        raise RuntimeError("PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY must decode to 32 bytes") from exc
    if len(key) != 32:
        raise RuntimeError("PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY must decode to 32 bytes")
    return key


def decrypt_envelope(item: ResetEmail) -> dict[str, str]:
    key = encryption_key()
    key_ref = __import__("hashlib").sha256(key).hexdigest()[:16]
    if key_ref != item.encryption_key_ref:
        raise NonRetryableEmailError("password reset envelope key reference mismatch")
    try:
        envelope = json.loads(item.encrypted_payload)
        if envelope.get("v") != 1 or envelope.get("alg") != "aes-256-gcm":
            raise ValueError("unsupported envelope")
        ciphertext = base64.b64decode(envelope["ciphertext"]) + base64.b64decode(envelope["tag"])
        plaintext = AESGCM(key).decrypt(base64.b64decode(envelope["iv"]), ciphertext, None)
        payload = json.loads(plaintext.decode("utf-8"))
        if not all(isinstance(payload.get(key_name), str) for key_name in ("email", "resetUrl", "expiresAt")):
            raise ValueError("invalid payload")
        return payload
    except NonRetryableEmailError:
        raise
    except Exception as exc:
        raise NonRetryableEmailError("password reset envelope could not be decrypted") from exc


class PostgresResetEmailStore:
    def __init__(self, database_url: str | None = None):
        self.database_url = (database_url or os.getenv("DATABASE_URL", "")).strip()
        self.max_attempts = int_env("PASSWORD_RESET_EMAIL_MAX_ATTEMPTS", 5, 1, 20)
        self.lease_seconds = int_env("PASSWORD_RESET_EMAIL_LEASE_SECONDS", 120, 30, 900)

    def _connect(self):
        import psycopg
        return psycopg.connect(self.database_url)

    def _admin(self, cursor) -> None:
        cursor.execute("SELECT set_current_platform_admin(true, %s)", (os.environ["PLATFORM_ADMIN_DB_CONTEXT_SECRET"],))

    def claim(self, outbox_id: str | None = None) -> ResetEmail | None:
        now = datetime.now(timezone.utc)
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('''
                UPDATE "PasswordResetEmailOutbox" AS outbox
                SET "status" = 'DEAD_LETTERED', "deadLetteredAt" = %s,
                    "leaseUntil" = NULL, "encryptedPayload" = %s,
                    "encryptionKeyRef" = %s,
                    "lastError" = 'PASSWORD_RESET_EMAIL_RECIPIENT_BLOCKED',
                    "updatedAt" = %s
                FROM "User" AS recipient, "Tenant" AS tenant
                WHERE recipient."id" = outbox."userId"
                  AND recipient."tenantId" = outbox."tenantId"
                  AND tenant."id" = outbox."tenantId"
                  AND (%s::text IS NULL OR outbox."id" = %s)
                  AND (
                    (outbox."status" IN ('PENDING', 'FAILED') AND outbox."nextAttemptAt" <= %s)
                    OR (outbox."status" = 'SENDING' AND outbox."leaseUntil" <= %s)
                  )
                  AND (
                    recipient."deletedAt" IS NOT NULL
                    OR recipient."suspendedAt" IS NOT NULL
                    OR recipient."emailDeliverySuppressedAt" IS NOT NULL
                    OR tenant."deletedAt" IS NOT NULL
                    OR tenant."status" IN ('SUSPENDED', 'PURGED')
                  )
            ''', (
                now,
                ERASED_ENCRYPTED_PAYLOAD,
                ERASED_ENCRYPTION_KEY_REF,
                now,
                outbox_id,
                outbox_id,
                now,
                now,
            ))
            cursor.execute('''
                SELECT outbox."id", outbox."tenantId", outbox."userId",
                       outbox."encryptedPayload", outbox."encryptionKeyRef", outbox."attempts"
                FROM "PasswordResetEmailOutbox" AS outbox
                JOIN "User" AS recipient
                  ON recipient."id" = outbox."userId" AND recipient."tenantId" = outbox."tenantId"
                JOIN "Tenant" AS tenant ON tenant."id" = outbox."tenantId"
                WHERE (%s::text IS NULL OR outbox."id" = %s)
                  AND outbox."attempts" < %s AND outbox."expiresAt" > %s
                  AND ((outbox."status" IN ('PENDING', 'FAILED') AND outbox."nextAttemptAt" <= %s)
                    OR (outbox."status" = 'SENDING' AND outbox."leaseUntil" <= %s))
                  AND recipient."deletedAt" IS NULL
                  AND recipient."suspendedAt" IS NULL
                  AND recipient."emailDeliverySuppressedAt" IS NULL
                  AND tenant."deletedAt" IS NULL
                  AND tenant."status" NOT IN ('SUSPENDED', 'PURGED')
                ORDER BY outbox."nextAttemptAt", outbox."createdAt", outbox."id"
                FOR UPDATE OF outbox SKIP LOCKED LIMIT 1
            ''', (outbox_id, outbox_id, self.max_attempts, now, now, now))
            row = cursor.fetchone()
            if not row:
                return None
            attempts = int(row[5]) + 1
            cursor.execute('''
                UPDATE "PasswordResetEmailOutbox"
                SET "status" = 'SENDING', "attempts" = %s, "leaseUntil" = %s,
                    "lastError" = NULL, "updatedAt" = %s WHERE "id" = %s
            ''', (attempts, now + timedelta(seconds=self.lease_seconds), now, row[0]))
            return ResetEmail(
                str(row[0]), str(row[1]), str(row[2]), str(row[3]), str(row[4]), attempts
            )

    def deliver_if_eligible(
        self,
        item: ResetEmail,
        email: str,
        deliver: Callable[[], None],
    ) -> bool:
        now = datetime.now(timezone.utc)
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('''
                SELECT "deletedAt", "status"
                FROM "Tenant"
                WHERE "id" = %s
                FOR UPDATE
            ''', (item.tenant_id,))
            tenant = cursor.fetchone()
            if not tenant or tenant[0] is not None or tenant[1] in ("SUSPENDED", "PURGED"):
                self._terminalize_lifecycle_block(cursor, item, now)
                return False

            cursor.execute('''
                SELECT "deletedAt", "suspendedAt", "emailDeliverySuppressedAt",
                       lower("email") = lower(%s)
                FROM "User"
                WHERE "id" = %s AND "tenantId" = %s
                FOR UPDATE
            ''', (email, item.user_id, item.tenant_id))
            recipient = cursor.fetchone()
            if (
                not recipient
                or recipient[0] is not None
                or recipient[1] is not None
                or recipient[2] is not None
                or not recipient[3]
            ):
                self._terminalize_lifecycle_block(cursor, item, now)
                return False

            cursor.execute('''
                SELECT 1
                FROM "PasswordResetEmailOutbox"
                WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING'
                  AND "leaseUntil" > %s
                FOR UPDATE
            ''', (item.id, item.attempts, now))
            if not cursor.fetchone():
                raise OutboxLeaseLostError("password reset outbox lease was lost before provider handoff")

            deliver()
            cursor.execute('''
                UPDATE "PasswordResetEmailOutbox"
                SET "status" = 'DELIVERED', "deliveredAt" = %s, "leaseUntil" = NULL,
                    "lastError" = NULL, "encryptedPayload" = %s,
                    "encryptionKeyRef" = %s, "updatedAt" = %s
                WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING'
            ''', (
                now,
                ERASED_ENCRYPTED_PAYLOAD,
                ERASED_ENCRYPTION_KEY_REF,
                now,
                item.id,
                item.attempts,
            ))
            if cursor.rowcount != 1:
                raise OutboxLeaseLostError("password reset outbox lease was lost after provider handoff")
            return True

    def _terminalize_lifecycle_block(self, cursor, item: ResetEmail, now: datetime) -> None:
        cursor.execute('''
            UPDATE "PasswordResetEmailOutbox"
            SET "status" = 'DEAD_LETTERED', "deadLetteredAt" = %s,
                "leaseUntil" = NULL, "encryptedPayload" = %s,
                "encryptionKeyRef" = %s,
                "lastError" = 'PASSWORD_RESET_EMAIL_RECIPIENT_BLOCKED',
                "updatedAt" = %s
            WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING'
        ''', (
            now,
            ERASED_ENCRYPTED_PAYLOAD,
            ERASED_ENCRYPTION_KEY_REF,
            now,
            item.id,
            item.attempts,
        ))
        if cursor.rowcount != 1:
            raise OutboxLeaseLostError("password reset outbox lease was lost during lifecycle block")

    def mark_delivered(self, item: ResetEmail) -> None:
        now = datetime.now(timezone.utc)
        self._update(item, '''UPDATE "PasswordResetEmailOutbox" SET "status" = 'DELIVERED',
            "deliveredAt" = %s, "leaseUntil" = NULL, "lastError" = NULL,
            "encryptedPayload" = %s, "encryptionKeyRef" = %s, "updatedAt" = %s
            WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING' ''',
            (now, ERASED_ENCRYPTED_PAYLOAD, ERASED_ENCRYPTION_KEY_REF, now, item.id, item.attempts))

    def mark_failed(self, item: ResetEmail, message: str, terminal: bool) -> None:
        now = datetime.now(timezone.utc)
        retry_at = now + timedelta(seconds=min(3600, 30 * (2 ** max(0, item.attempts - 1))))
        status = "DEAD_LETTERED" if terminal else "FAILED"
        encrypted_payload = ERASED_ENCRYPTED_PAYLOAD if terminal else item.encrypted_payload
        encryption_key_ref = ERASED_ENCRYPTION_KEY_REF if terminal else item.encryption_key_ref
        self._update(item, '''UPDATE "PasswordResetEmailOutbox" SET "status" = %s,
            "nextAttemptAt" = %s, "leaseUntil" = NULL, "deadLetteredAt" = %s,
            "encryptedPayload" = %s, "encryptionKeyRef" = %s,
            "lastError" = %s, "updatedAt" = %s
            WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING' ''',
            (status, retry_at, now if terminal else None, encrypted_payload, encryption_key_ref,
             message[:1000], now, item.id, item.attempts))

    def dead_lettered_count(self) -> int:
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('SELECT COUNT(*) FROM "PasswordResetEmailOutbox" WHERE "status" = \'DEAD_LETTERED\'')
            return int(cursor.fetchone()[0])

    def last_dead_letter_unixtime(self) -> float:
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('''
                SELECT COALESCE(EXTRACT(EPOCH FROM MAX("deadLetteredAt")), 0)
                FROM "PasswordResetEmailOutbox"
                WHERE "status" = 'DEAD_LETTERED'
            ''')
            return float(cursor.fetchone()[0])

    def recent_provider_failures(self, window_seconds: int) -> tuple[int, float]:
        since = datetime.now(timezone.utc) - timedelta(seconds=window_seconds)
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('''
                SELECT COALESCE(SUM(GREATEST("attempts", 1)), 0),
                       COALESCE(EXTRACT(EPOCH FROM MAX("updatedAt")), 0)
                FROM "PasswordResetEmailOutbox"
                WHERE "updatedAt" >= %s
                  AND "lastError" IN (
                    'PASSWORD_RESET_EMAIL_PROVIDER_REJECTED',
                    'PASSWORD_RESET_EMAIL_PROVIDER_RETRYABLE'
                  )
            ''', (since,))
            row = cursor.fetchone()
            return int(row[0]), float(row[1])

    def terminalize_stranded(self) -> int:
        now = datetime.now(timezone.utc)
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('''
                UPDATE "PasswordResetEmailOutbox"
                SET "status" = 'DEAD_LETTERED', "deadLetteredAt" = %s, "leaseUntil" = NULL,
                    "encryptedPayload" = %s, "encryptionKeyRef" = %s,
                    "lastError" = CASE WHEN "expiresAt" <= %s
                        THEN 'Password reset email expired before delivery'
                        ELSE 'Password reset email final-attempt lease expired with unknown outcome' END,
                    "updatedAt" = %s
                WHERE "status" IN ('PENDING', 'FAILED', 'SENDING')
                  AND ("expiresAt" <= %s OR ("status" = 'SENDING' AND "attempts" >= %s AND "leaseUntil" <= %s))
            ''', (
                now,
                ERASED_ENCRYPTED_PAYLOAD,
                ERASED_ENCRYPTION_KEY_REF,
                now,
                now,
                now,
                self.max_attempts,
                now,
            ))
            return int(cursor.rowcount)

    def _update(self, item: ResetEmail, sql: str, params: tuple) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute(sql, params)
            if cursor.rowcount != 1:
                raise OutboxLeaseLostError("password reset outbox lease was lost before state transition")


def send_with_resend(item: ResetEmail, payload: dict[str, str]) -> None:
    subject = "Reset your LunchLineup password"
    reset_url = html.escape(payload["resetUrl"], quote=True)
    expires_at = html.escape(payload["expiresAt"])
    body = json.dumps({
        "from": os.environ["EMAIL_FROM"],
        "to": [payload["email"]],
        "subject": subject,
        "html": f'<p>Use this link to reset your password:</p><p><a href="{reset_url}">Reset password</a></p><p>This link expires at {expires_at}.</p>',
    }).encode("utf-8")
    req = request.Request("https://api.resend.com/emails", data=body, method="POST", headers={
        "Authorization": f"Bearer {os.environ['RESEND_API_KEY']}",
        "Content-Type": "application/json",
        "Idempotency-Key": f"password-reset/{item.id}",
    })
    try:
        with request.urlopen(req, timeout=15) as response:
            if response.status >= 300:
                raise RetryableProviderEmailError("email provider returned an unsuccessful response")
    except error.HTTPError as exc:
        if exc.code == 429 or exc.code >= 500:
            raise RetryableProviderEmailError("email provider is temporarily unavailable") from exc
        raise ProviderRejectedEmailError("email provider rejected the password reset delivery") from exc
    except (error.URLError, TimeoutError) as exc:
        raise RetryableProviderEmailError("email provider request failed") from exc


async def dispatch_password_reset_email(outbox_id: str | None = None, store: ResetEmailStore | None = None) -> dict[str, object]:
    active_store = store or PostgresResetEmailStore()
    item = await asyncio.to_thread(active_store.claim, outbox_id)
    if not item:
        return {"skipped": True}
    max_attempts = int_env("PASSWORD_RESET_EMAIL_MAX_ATTEMPTS", 5, 1, 20)
    try:
        payload = decrypt_envelope(item)
        delivered = await asyncio.to_thread(
            active_store.deliver_if_eligible,
            item,
            payload["email"],
            lambda: send_with_resend(item, payload),
        )
        if not delivered:
            DELIVERY_TOTAL.labels(status="dead_lettered").inc()
            logger.error("Password reset email lifecycle-blocked outbox_ref=%s", item.id)
            raise LifecycleBlockedEmailError("recipient lifecycle blocks email delivery")
        DELIVERY_TOTAL.labels(status="delivered").inc()
        return {"delivered": True, "outbox_id": item.id}
    except LifecycleBlockedEmailError:
        raise
    except OutboxLeaseLostError:
        DELIVERY_TOTAL.labels(status="lease_lost").inc()
        raise
    except Exception as exc:
        terminal = isinstance(exc, NonRetryableEmailError) or item.attempts >= max_attempts
        failure_code = password_reset_failure_code(exc, terminal)
        await asyncio.to_thread(active_store.mark_failed, item, failure_code, terminal)
        DELIVERY_TOTAL.labels(status="dead_lettered" if terminal else "retrying").inc()
        if terminal:
            logger.error("Password reset email dead-lettered outbox_ref=%s attempts=%s", item.id, item.attempts)
            if isinstance(exc, ProviderEmailFailure):
                raise ProviderRejectedEmailError("password reset provider delivery was dead-lettered") from exc
            raise NonRetryableEmailError("password reset email delivery was dead-lettered") from exc
        if isinstance(exc, ProviderEmailFailure):
            raise RetryableProviderEmailError("password reset provider delivery will retry") from exc
        raise RetryableEmailError("password reset email delivery will retry") from exc


async def sweep_password_reset_email_outbox(
    store: ResetEmailStore,
    batch_size: int,
    provider_failure_window: ProviderFailureWindow | None = None,
) -> dict[str, int]:
    provider_window = int_env("PASSWORD_RESET_EMAIL_PROVIDER_HEALTH_WINDOW_SECONDS", 300, 30, 3600)
    provider_threshold = int_env("PASSWORD_RESET_EMAIL_PROVIDER_FAILURE_THRESHOLD", 3, 2, 100)
    observed_provider_failures = provider_failure_window or ProviderFailureWindow()
    terminalized = await asyncio.to_thread(store.terminalize_stranded)
    if terminalized:
        DELIVERY_TOTAL.labels(status="dead_lettered").inc(terminalized)
        logger.error("Password reset email stranded rows terminalized=%s", terminalized)

    delivered = 0
    provider_retryable = 0
    provider_terminal = 0
    for _ in range(batch_size):
        try:
            result = await dispatch_password_reset_email(store=store)
        except ProviderRejectedEmailError:
            provider_terminal += 1
            observed_provider_failures.record()
            SWEEP_PROVIDER_FAILURES.labels(kind="terminal").inc()
            continue
        except RetryableProviderEmailError:
            provider_retryable += 1
            observed_provider_failures.record()
            SWEEP_PROVIDER_FAILURES.labels(kind="retryable").inc()
            continue
        except (RetryableEmailError, NonRetryableEmailError):
            continue
        if result.get("skipped"):
            break
        delivered += 1

    dead_lettered = await asyncio.to_thread(store.dead_lettered_count)
    last_dead_letter = await asyncio.to_thread(store.last_dead_letter_unixtime)
    durable_provider_failures, durable_last_provider_failure = await asyncio.to_thread(
        store.recent_provider_failures,
        provider_window,
    )
    in_process_provider_failures, in_process_last_provider_failure = (
        observed_provider_failures.recent(provider_window)
    )
    recent_provider_failures = max(
        durable_provider_failures,
        in_process_provider_failures,
    )
    last_provider_failure = max(
        durable_last_provider_failure,
        in_process_last_provider_failure,
    )
    systemic_provider_failure = int(recent_provider_failures >= provider_threshold)
    DEAD_LETTERED.set(dead_lettered)
    SWEEP_LAST_DEAD_LETTER.set(last_dead_letter)
    SWEEP_RECENT_PROVIDER_FAILURES.set(recent_provider_failures)
    SWEEP_LAST_PROVIDER_FAILURE.set(last_provider_failure)
    SWEEP_SYSTEMIC_PROVIDER_FAILURE.set(systemic_provider_failure)
    if dead_lettered:
        logger.error("Password reset email terminal backlog count=%s", dead_lettered)
    if delivered:
        logger.info("Password reset email outbox delivered=%s", delivered)
    return {
        "delivered": delivered,
        "dead_lettered": dead_lettered,
        "terminalized": terminalized,
        "provider_retryable": provider_retryable,
        "provider_terminal": provider_terminal,
        "recent_provider_failures": recent_provider_failures,
        "systemic_provider_failure": systemic_provider_failure,
    }


async def run_password_reset_email_loop(store: ResetEmailStore | None = None) -> None:
    interval = int_env("PASSWORD_RESET_EMAIL_SWEEP_INTERVAL_SECONDS", 10, 1, 300)
    batch_size = int_env("PASSWORD_RESET_EMAIL_SWEEP_BATCH_SIZE", 25, 1, 100)
    active_store = store or PostgresResetEmailStore()
    SWEEP_RUNNING.set(1)
    SWEEP_READY.set(0)
    SWEEP_SYSTEMIC_PROVIDER_FAILURE.set(0)
    provider_outage_logged = False
    provider_failure_window = ProviderFailureWindow()
    try:
        while True:
            try:
                result = await sweep_password_reset_email_outbox(
                    active_store,
                    batch_size,
                    provider_failure_window,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                SWEEP_FAILURES.inc()
                SWEEP_READY.set(0)
                logger.error("Password reset email sweep failed reason=%s", exc.__class__.__name__)
            else:
                if result["systemic_provider_failure"]:
                    SWEEP_READY.set(0)
                    SWEEP_SYSTEMIC_PROVIDER_FAILURE.set(1)
                    if not provider_outage_logged:
                        logger.error(
                            "Password reset email provider outage threshold reached recent_failures=%s",
                            result["recent_provider_failures"],
                        )
                    provider_outage_logged = True
                else:
                    if provider_outage_logged:
                        logger.info("Password reset email provider delivery readiness recovered")
                    provider_outage_logged = False
                    SWEEP_READY.set(1)
                    SWEEP_SYSTEMIC_PROVIDER_FAILURE.set(0)
                    SWEEP_LAST_SUCCESS.set_to_current_time()
            await asyncio.sleep(interval)
    finally:
        SWEEP_READY.set(0)
        SWEEP_SYSTEMIC_PROVIDER_FAILURE.set(0)
        SWEEP_RUNNING.set(0)
