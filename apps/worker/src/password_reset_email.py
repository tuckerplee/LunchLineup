from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import html
import json
import logging
import os
from typing import Protocol
from urllib import error, request

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from prometheus_client import Counter, Gauge

logger = logging.getLogger("worker.password_reset_email")
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


class RetryableEmailError(RuntimeError):
    pass


class NonRetryableEmailError(RuntimeError):
    pass


@dataclass(frozen=True)
class ResetEmail:
    id: str
    tenant_id: str
    encrypted_payload: str
    encryption_key_ref: str
    attempts: int


class ResetEmailStore(Protocol):
    def claim(self, outbox_id: str | None = None) -> ResetEmail | None: ...
    def mark_delivered(self, item: ResetEmail) -> None: ...
    def mark_failed(self, item: ResetEmail, message: str, terminal: bool) -> None: ...
    def dead_lettered_count(self) -> int: ...
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
                SELECT "id", "tenantId", "encryptedPayload", "encryptionKeyRef", "attempts"
                FROM "PasswordResetEmailOutbox"
                WHERE (%s::text IS NULL OR "id" = %s)
                  AND "attempts" < %s AND "expiresAt" > %s
                  AND (("status" IN ('PENDING', 'FAILED') AND "nextAttemptAt" <= %s)
                    OR ("status" = 'SENDING' AND "leaseUntil" <= %s))
                ORDER BY "nextAttemptAt", "createdAt", "id"
                FOR UPDATE SKIP LOCKED LIMIT 1
            ''', (outbox_id, outbox_id, self.max_attempts, now, now, now))
            row = cursor.fetchone()
            if not row:
                return None
            attempts = int(row[4]) + 1
            cursor.execute('''
                UPDATE "PasswordResetEmailOutbox"
                SET "status" = 'SENDING', "attempts" = %s, "leaseUntil" = %s,
                    "lastError" = NULL, "updatedAt" = %s WHERE "id" = %s
            ''', (attempts, now + timedelta(seconds=self.lease_seconds), now, row[0]))
            return ResetEmail(str(row[0]), str(row[1]), str(row[2]), str(row[3]), attempts)

    def mark_delivered(self, item: ResetEmail) -> None:
        now = datetime.now(timezone.utc)
        self._update(item, '''UPDATE "PasswordResetEmailOutbox" SET "status" = 'DELIVERED',
            "deliveredAt" = %s, "leaseUntil" = NULL, "lastError" = NULL, "updatedAt" = %s
            WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING' ''', (now, now, item.id, item.attempts))

    def mark_failed(self, item: ResetEmail, message: str, terminal: bool) -> None:
        now = datetime.now(timezone.utc)
        retry_at = now + timedelta(seconds=min(3600, 30 * (2 ** max(0, item.attempts - 1))))
        self._update(item, '''UPDATE "PasswordResetEmailOutbox" SET "status" = %s,
            "nextAttemptAt" = %s, "leaseUntil" = NULL, "deadLetteredAt" = %s,
            "lastError" = %s, "updatedAt" = %s
            WHERE "id" = %s AND "attempts" = %s AND "status" = 'SENDING' ''',
            ("DEAD_LETTERED" if terminal else "FAILED", retry_at, now if terminal else None, message[:1000], now, item.id, item.attempts))

    def dead_lettered_count(self) -> int:
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('SELECT COUNT(*) FROM "PasswordResetEmailOutbox" WHERE "status" = \'DEAD_LETTERED\'')
            return int(cursor.fetchone()[0])

    def terminalize_stranded(self) -> int:
        now = datetime.now(timezone.utc)
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute('''
                UPDATE "PasswordResetEmailOutbox"
                SET "status" = 'DEAD_LETTERED', "deadLetteredAt" = %s, "leaseUntil" = NULL,
                    "lastError" = CASE WHEN "expiresAt" <= %s
                        THEN 'Password reset email expired before delivery'
                        ELSE 'Password reset email final-attempt lease expired with unknown outcome' END,
                    "updatedAt" = %s
                WHERE "status" IN ('PENDING', 'FAILED', 'SENDING')
                  AND ("expiresAt" <= %s OR ("status" = 'SENDING' AND "attempts" >= %s AND "leaseUntil" <= %s))
            ''', (now, now, now, now, self.max_attempts, now))
            return int(cursor.rowcount)

    def _update(self, item: ResetEmail, sql: str, params: tuple) -> None:
        with self._connect() as connection, connection.cursor() as cursor:
            self._admin(cursor)
            cursor.execute(sql, params)


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
                raise RetryableEmailError("email provider returned an unsuccessful response")
    except error.HTTPError as exc:
        if exc.code == 429 or exc.code >= 500:
            raise RetryableEmailError("email provider is temporarily unavailable") from exc
        raise NonRetryableEmailError("email provider rejected the password reset delivery") from exc
    except (error.URLError, TimeoutError) as exc:
        raise RetryableEmailError("email provider request failed") from exc


async def dispatch_password_reset_email(outbox_id: str | None = None, store: ResetEmailStore | None = None) -> dict[str, object]:
    active_store = store or PostgresResetEmailStore()
    item = await asyncio.to_thread(active_store.claim, outbox_id)
    if not item:
        return {"skipped": True}
    max_attempts = int_env("PASSWORD_RESET_EMAIL_MAX_ATTEMPTS", 5, 1, 20)
    try:
        payload = decrypt_envelope(item)
        await asyncio.to_thread(send_with_resend, item, payload)
        await asyncio.to_thread(active_store.mark_delivered, item)
        DELIVERY_TOTAL.labels(status="delivered").inc()
        return {"delivered": True, "outbox_id": item.id}
    except Exception as exc:
        terminal = isinstance(exc, NonRetryableEmailError) or item.attempts >= max_attempts
        await asyncio.to_thread(active_store.mark_failed, item, str(exc), terminal)
        DELIVERY_TOTAL.labels(status="dead_lettered" if terminal else "retrying").inc()
        if terminal:
            logger.error("Password reset email dead-lettered outbox_ref=%s attempts=%s", item.id, item.attempts)
            raise NonRetryableEmailError("password reset email delivery was dead-lettered") from exc
        raise RetryableEmailError("password reset email delivery will retry") from exc


async def sweep_password_reset_email_outbox(
    store: ResetEmailStore,
    batch_size: int,
) -> dict[str, int]:
    terminalized = await asyncio.to_thread(store.terminalize_stranded)
    if terminalized:
        DELIVERY_TOTAL.labels(status="dead_lettered").inc(terminalized)
        logger.error("Password reset email stranded rows terminalized=%s", terminalized)

    delivered = 0
    for _ in range(batch_size):
        try:
            result = await dispatch_password_reset_email(store=store)
        except (RetryableEmailError, NonRetryableEmailError):
            continue
        if result.get("skipped"):
            break
        delivered += 1

    dead_lettered = await asyncio.to_thread(store.dead_lettered_count)
    DEAD_LETTERED.set(dead_lettered)
    if dead_lettered:
        logger.error("Password reset email terminal backlog count=%s", dead_lettered)
    if delivered:
        logger.info("Password reset email outbox delivered=%s", delivered)
    return {
        "delivered": delivered,
        "dead_lettered": dead_lettered,
        "terminalized": terminalized,
    }


async def run_password_reset_email_loop(store: ResetEmailStore | None = None) -> None:
    interval = int_env("PASSWORD_RESET_EMAIL_SWEEP_INTERVAL_SECONDS", 10, 1, 300)
    batch_size = int_env("PASSWORD_RESET_EMAIL_SWEEP_BATCH_SIZE", 25, 1, 100)
    active_store = store or PostgresResetEmailStore()
    SWEEP_RUNNING.set(1)
    SWEEP_READY.set(0)
    try:
        while True:
            try:
                await sweep_password_reset_email_outbox(active_store, batch_size)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                SWEEP_FAILURES.inc()
                SWEEP_READY.set(0)
                logger.error("Password reset email sweep failed reason=%s", exc.__class__.__name__)
            else:
                SWEEP_READY.set(1)
                SWEEP_LAST_SUCCESS.set_to_current_time()
            await asyncio.sleep(interval)
    finally:
        SWEEP_READY.set(0)
        SWEEP_RUNNING.set(0)
