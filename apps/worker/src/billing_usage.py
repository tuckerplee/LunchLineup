"""Durable Stripe metered-usage preparation, claiming, and delivery."""

from __future__ import annotations

import asyncio
from dataclasses import dataclass
from datetime import datetime, timedelta, timezone
import hashlib
import json
import logging
import os
import re
from typing import Any, Protocol
from urllib.error import HTTPError, URLError
from urllib.parse import urlencode
from urllib.request import Request, urlopen
import uuid

logger = logging.getLogger("worker.billing_usage")

ACTIVE_STAFF_METRIC = "ACTIVE_STAFF"
IDENTIFIER_PATTERN = re.compile(r"^[A-Za-z0-9._:@+-]{1,128}$")
METER_EVENT_NAME_PATTERN = re.compile(r"^[A-Za-z0-9_.:-]{1,100}$")
RETRYABLE_HTTP_STATUSES = {408, 409, 429, 500, 502, 503, 504}


class RetryableBillingError(RuntimeError):
    pass


class NonRetryableBillingError(RuntimeError):
    pass


@dataclass(frozen=True)
class UsageEvent:
    id: str
    tenant_id: str
    event_name: str
    stripe_customer_id: str
    quantity: int
    identifier: str
    idempotency_key: str
    timestamp: datetime
    attempts: int


@dataclass(frozen=True)
class StripeMeterResult:
    object_id: str | None
    request_id: str | None


class UsageStore(Protocol):
    def claim(self, tenant_id: str, usage_event_id: str | None = None) -> UsageEvent | None: ...

    def mark_sent(self, event: UsageEvent, result: StripeMeterResult) -> None: ...

    def mark_failed(self, event: UsageEvent, message: str, dead_lettered: bool) -> None: ...

    def list_due_tenant_ids(self, limit: int) -> list[str]: ...

    def terminalize_expired_final_attempts(self, limit: int) -> int: ...

    def requeue_dead_lettered(self, limit: int) -> int: ...


class MeterClient(Protocol):
    def send(self, event: UsageEvent) -> StripeMeterResult: ...


def int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def metered_usage_enabled() -> bool:
    return os.getenv("STRIPE_METERED_USAGE_ENABLED", "").strip().lower() == "true"


def dead_letter_replay_enabled() -> bool:
    return os.getenv("STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED", "").strip().lower() == "true"


def require_last_value_aggregation() -> None:
    if os.getenv("STRIPE_METER_AGGREGATION", "").strip().lower() != "last":
        raise NonRetryableBillingError("STRIPE_METER_AGGREGATION must be last for usage replay")


def validate_billing_runtime_config() -> None:
    if not metered_usage_enabled():
        return
    for key in ("DATABASE_URL", "STRIPE_SECRET_KEY", "STRIPE_METER_EVENT_NAME"):
        if not os.getenv(key, "").strip():
            raise RuntimeError(f"{key} is required when Stripe metered usage is enabled")
    event_name = os.environ["STRIPE_METER_EVENT_NAME"].strip()
    if not METER_EVENT_NAME_PATTERN.fullmatch(event_name):
        raise RuntimeError("STRIPE_METER_EVENT_NAME is invalid")
    try:
        require_last_value_aggregation()
    except NonRetryableBillingError as exc:
        raise RuntimeError(str(exc)) from exc


def snapshot_interval_seconds() -> int:
    return int_env("STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS", 300, 60, 3600)


def snapshot_period(now: datetime) -> tuple[datetime, datetime]:
    interval = snapshot_interval_seconds()
    epoch_seconds = int(now.astimezone(timezone.utc).timestamp())
    start = datetime.fromtimestamp(epoch_seconds - (epoch_seconds % interval), timezone.utc)
    return start, start + timedelta(seconds=interval)


def usage_snapshot_identity(tenant_id: str, period_start: datetime) -> tuple[str, str]:
    bucket = period_start.astimezone(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    digest = hashlib.sha256(f"{tenant_id}:{ACTIVE_STAFF_METRIC}:{bucket}".encode("utf-8")).hexdigest()[:24]
    identifier = f"ll_{ACTIVE_STAFF_METRIC.lower()}_{bucket}_{digest}"
    return identifier, f"stripe_usage_{identifier}"


class PostgresUsageStore:
    def __init__(self, database_url: str | None = None):
        self.database_url = (database_url or os.getenv("DATABASE_URL", "")).strip()
        if not self.database_url:
            raise NonRetryableBillingError("DATABASE_URL is required for billing usage dispatch")
        self.max_attempts = int_env("STRIPE_USAGE_MAX_ATTEMPTS", 5, 1, 20)
        self.lease_seconds = int_env("STRIPE_USAGE_CLAIM_LEASE_SECONDS", 300, 30, 3600)

    def claim(self, tenant_id: str, usage_event_id: str | None = None) -> UsageEvent | None:
        psycopg = self._psycopg()
        now = datetime.now(timezone.utc)
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (tenant_id,))
                if usage_event_id is None:
                    self._prepare_usage_snapshot(cursor, tenant_id, now)
                stale_before = now - timedelta(seconds=self.lease_seconds)
                cursor.execute(
                    '''
                    SELECT
                        "id", "tenantId", "eventName", "stripeCustomerId", "quantity",
                        "identifier", "idempotencyKey", "periodStart", "attempts"
                    FROM "StripeUsageEvent"
                    WHERE "tenantId" = %s
                      AND (%s::text IS NULL OR "id" = %s)
                      AND "attempts" < %s
                      AND (
                        ("status" IN ('PENDING', 'FAILED') AND "nextAttemptAt" <= %s)
                        OR ("status" = 'SENDING' AND "updatedAt" <= %s)
                      )
                    ORDER BY "nextAttemptAt" ASC, "createdAt" ASC, "id" ASC
                    FOR UPDATE SKIP LOCKED
                    LIMIT 1
                    ''',
                    (tenant_id, usage_event_id, usage_event_id, self.max_attempts, now, stale_before),
                )
                row = cursor.fetchone()
                if not row:
                    return None
                attempts = int(row[8]) + 1
                cursor.execute(
                    '''
                    UPDATE "StripeUsageEvent"
                    SET "status" = 'SENDING', "attempts" = %s, "lastError" = NULL,
                        "nextAttemptAt" = %s, "submittedAt" = %s, "updatedAt" = %s
                    WHERE "id" = %s AND "tenantId" = %s
                    ''',
                    (attempts, now + timedelta(seconds=self.lease_seconds), now, now, row[0], tenant_id),
                )
                return UsageEvent(
                    id=str(row[0]),
                    tenant_id=str(row[1]),
                    event_name=str(row[2]),
                    stripe_customer_id=str(row[3]),
                    quantity=int(row[4]),
                    identifier=str(row[5]),
                    idempotency_key=str(row[6]),
                    timestamp=row[7],
                    attempts=attempts,
                )

    def mark_sent(self, event: UsageEvent, result: StripeMeterResult) -> None:
        self._update_event(
            event,
            '''
            UPDATE "StripeUsageEvent"
            SET "status" = 'SENT', "sentAt" = %s, "stripeObjectId" = %s,
                "stripeRequestId" = %s, "lastError" = NULL, "updatedAt" = %s
            WHERE "id" = %s AND "tenantId" = %s AND "status" = 'SENDING' AND "attempts" = %s
            ''',
            lambda now: (now, result.object_id, result.request_id, now, event.id, event.tenant_id, event.attempts),
        )

    def mark_failed(self, event: UsageEvent, message: str, dead_lettered: bool) -> None:
        now = datetime.now(timezone.utc)
        delay_minutes = min(60, max(1, 2 ** min(event.attempts, 6)))
        status = "DEAD_LETTERED" if dead_lettered else "FAILED"
        self._update_event(
            event,
            '''
            UPDATE "StripeUsageEvent"
            SET "status" = %s, "nextAttemptAt" = %s, "lastError" = %s, "updatedAt" = %s
            WHERE "id" = %s AND "tenantId" = %s AND "status" = 'SENDING' AND "attempts" = %s
            ''',
            lambda _: (
                status,
                now + timedelta(minutes=delay_minutes),
                message[:1000],
                now,
                event.id,
                event.tenant_id,
                event.attempts,
            ),
        )

    def list_due_tenant_ids(self, limit: int) -> list[str]:
        psycopg = self._psycopg()
        now = datetime.now(timezone.utc)
        stale_before = now - timedelta(seconds=self.lease_seconds)
        period_start, period_end = snapshot_period(now)
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                capability = os.getenv("PLATFORM_ADMIN_DB_CONTEXT_SECRET", "").strip()
                if not capability:
                    raise NonRetryableBillingError("PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for usage metering")
                cursor.execute("SELECT set_current_platform_admin(true, %s)", (capability,))
                cursor.execute(
                    '''
                    WITH due_retries AS (
                        SELECT DISTINCT ON (usage."tenantId")
                            usage."tenantId",
                            usage."nextAttemptAt" AS "sortAt",
                            0 AS priority
                        FROM "StripeUsageEvent" usage
                        WHERE usage."attempts" < %s
                          AND (
                            (usage."status" IN ('PENDING', 'FAILED') AND usage."nextAttemptAt" <= %s)
                            OR (usage."status" = 'SENDING' AND usage."updatedAt" <= %s)
                          )
                        ORDER BY usage."tenantId", usage."nextAttemptAt", usage."createdAt", usage."id"
                    ),
                    active_without_current_snapshot AS (
                        SELECT
                            tenant."id" AS "tenantId",
                            COALESCE(MAX(history."periodStart"), TIMESTAMP '-infinity') AS "sortAt",
                            1 AS priority
                        FROM "Tenant" tenant
                        LEFT JOIN "StripeUsageEvent" history
                          ON history."tenantId" = tenant."id"
                         AND history."metric" = 'ACTIVE_STAFF'
                        WHERE tenant."status" = 'ACTIVE'
                          AND tenant."deletedAt" IS NULL
                          AND tenant."stripeCustomerId" IS NOT NULL
                          AND tenant."stripeSubscriptionId" IS NOT NULL
                          AND NOT EXISTS (
                            SELECT 1
                            FROM "StripeUsageEvent" current_snapshot
                            WHERE current_snapshot."tenantId" = tenant."id"
                              AND current_snapshot."metric" = 'ACTIVE_STAFF'
                              AND current_snapshot."periodStart" = %s
                              AND current_snapshot."periodEnd" = %s
                          )
                          AND NOT EXISTS (
                            SELECT 1
                            FROM due_retries retry
                            WHERE retry."tenantId" = tenant."id"
                          )
                        GROUP BY tenant."id"
                    )
                    SELECT candidates."tenantId"
                    FROM (
                        SELECT * FROM due_retries
                        UNION ALL
                        SELECT * FROM active_without_current_snapshot
                    ) candidates
                    ORDER BY candidates.priority, candidates."sortAt", candidates."tenantId"
                    LIMIT %s
                    ''',
                    (self.max_attempts, now, stale_before, period_start, period_end, limit),
                )
                return [str(row[0]) for row in cursor.fetchall()]

    def terminalize_expired_final_attempts(self, limit: int) -> int:
        psycopg = self._psycopg()
        now = datetime.now(timezone.utc)
        stale_before = now - timedelta(seconds=self.lease_seconds)
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                capability = os.getenv("PLATFORM_ADMIN_DB_CONTEXT_SECRET", "").strip()
                if not capability:
                    raise NonRetryableBillingError("PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for usage metering")
                cursor.execute("SELECT set_current_platform_admin(true, %s)", (capability,))
                cursor.execute(
                    '''
                    WITH expired AS (
                        SELECT "id"
                        FROM "StripeUsageEvent"
                        WHERE "status" = 'SENDING'
                          AND "attempts" >= %s
                          AND "updatedAt" <= %s
                        ORDER BY "updatedAt" ASC, "createdAt" ASC, "id" ASC
                        FOR UPDATE SKIP LOCKED
                        LIMIT %s
                    )
                    UPDATE "StripeUsageEvent" usage
                    SET "status" = 'DEAD_LETTERED',
                        "nextAttemptAt" = %s,
                        "lastError" = 'Final delivery lease expired with an unknown Stripe outcome',
                        "metadata" = COALESCE(usage."metadata", '{}'::jsonb) || jsonb_build_object(
                            'finalAttemptLeaseExpiredAt', %s,
                            'finalAttemptOutcome', 'unknown'
                        ),
                        "updatedAt" = %s
                    FROM expired
                    WHERE usage."id" = expired."id"
                      AND usage."status" = 'SENDING'
                      AND usage."attempts" >= %s
                    RETURNING usage."id"
                    ''',
                    (self.max_attempts, stale_before, limit, now, now.isoformat(), now, self.max_attempts),
                )
                return len(cursor.fetchall())

    def requeue_dead_lettered(self, limit: int) -> int:
        if not dead_letter_replay_enabled():
            return 0
        require_last_value_aggregation()
        psycopg = self._psycopg()
        now = datetime.now(timezone.utc)
        minimum_age = int_env("STRIPE_USAGE_DEAD_LETTER_REPLAY_MIN_AGE_SECONDS", 900, 60, 86400)
        max_replays = int_env("STRIPE_USAGE_DEAD_LETTER_MAX_REPLAYS", 1, 1, 5)
        replay_before = now - timedelta(seconds=minimum_age)
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                capability = os.getenv("PLATFORM_ADMIN_DB_CONTEXT_SECRET", "").strip()
                if not capability:
                    raise NonRetryableBillingError("PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for usage metering")
                cursor.execute("SELECT set_current_platform_admin(true, %s)", (capability,))
                cursor.execute(
                    '''
                    WITH replayable AS (
                        SELECT "id"
                        FROM "StripeUsageEvent"
                        WHERE "status" = 'DEAD_LETTERED'
                          AND "updatedAt" <= %s
                          AND CASE
                                WHEN COALESCE("metadata"->>'deadLetterReplayCount', '') ~ '^[0-9]+$'
                                THEN ("metadata"->>'deadLetterReplayCount')::int
                                ELSE 0
                              END < %s
                        ORDER BY "periodStart" ASC, "createdAt" ASC, "id" ASC
                        FOR UPDATE SKIP LOCKED
                        LIMIT %s
                    )
                    UPDATE "StripeUsageEvent" usage
                    SET "status" = 'FAILED',
                        "attempts" = 0,
                        "identifier" = 'll_replay_' || md5(
                            usage."id" || ':' || usage."identifier" || ':' ||
                            COALESCE(usage."metadata"->>'deadLetterReplayCount', '0')
                        ),
                        "idempotencyKey" = 'stripe_usage_replay_' || md5(
                            usage."id" || ':' || usage."idempotencyKey" || ':' ||
                            COALESCE(usage."metadata"->>'deadLetterReplayCount', '0')
                        ),
                        "nextAttemptAt" = %s,
                        "lastError" = 'Operator-gated replay queued after dead-letter',
                        "metadata" = COALESCE(usage."metadata", '{}'::jsonb) || jsonb_build_object(
                            'logicalUsageIdentity', COALESCE(
                                usage."metadata"->>'logicalUsageIdentity', usage."identifier"
                            ),
                            'deadLetterReplayCount',
                            CASE
                              WHEN COALESCE(usage."metadata"->>'deadLetterReplayCount', '') ~ '^[0-9]+$'
                              THEN (usage."metadata"->>'deadLetterReplayCount')::int + 1
                              ELSE 1
                            END,
                            'deadLetterLastReplayedAt', %s,
                            'deadLetterPreviousError', LEFT(COALESCE(usage."lastError", ''), 1000),
                            'deadLetterPreviousIdentifier', usage."identifier",
                            'deadLetterPreviousIdempotencyKey', usage."idempotencyKey",
                            'deadLetterReplayDisposition', 'operator_replay_fresh_transport'
                        ),
                        "updatedAt" = %s
                    FROM replayable
                    WHERE usage."id" = replayable."id"
                      AND usage."status" = 'DEAD_LETTERED'
                    RETURNING usage."id"
                    ''',
                    (replay_before, max_replays, limit, now, now.isoformat(), now),
                )
                return len(cursor.fetchall())

    def _prepare_usage_snapshot(self, cursor: Any, tenant_id: str, now: datetime) -> None:
        cursor.execute(
            '''
            SELECT "stripeCustomerId"
            FROM "Tenant"
            WHERE "id" = %s AND "status" = 'ACTIVE' AND "deletedAt" IS NULL
              AND "stripeCustomerId" IS NOT NULL AND "stripeSubscriptionId" IS NOT NULL
            ''',
            (tenant_id,),
        )
        tenant = cursor.fetchone()
        if not tenant:
            return
        cursor.execute(
            'SELECT COUNT(*) FROM "User" WHERE "tenantId" = %s AND "deletedAt" IS NULL',
            (tenant_id,),
        )
        quantity = int(cursor.fetchone()[0])
        period_start, period_end = snapshot_period(now)
        identifier, idempotency_key = usage_snapshot_identity(tenant_id, period_start)
        event_name = os.getenv("STRIPE_METER_EVENT_NAME", "").strip()
        if not METER_EVENT_NAME_PATTERN.fullmatch(event_name):
            raise NonRetryableBillingError("STRIPE_METER_EVENT_NAME is invalid")
        cursor.execute(
            '''
            INSERT INTO "StripeUsageEvent" (
                "id", "tenantId", "metric", "periodStart", "periodEnd", "quantity",
                "eventName", "stripeCustomerId", "identifier", "idempotencyKey",
                "status", "attempts", "nextAttemptAt", "metadata", "createdAt", "updatedAt"
            ) VALUES (%s, %s, 'ACTIVE_STAFF', %s, %s, %s, %s, %s, %s, %s,
                      'PENDING', 0, %s, %s::jsonb, %s, %s)
            ON CONFLICT ("tenantId", "metric", "periodStart", "periodEnd") DO UPDATE SET
                "quantity" = EXCLUDED."quantity",
                "eventName" = EXCLUDED."eventName",
                "stripeCustomerId" = EXCLUDED."stripeCustomerId",
                "updatedAt" = EXCLUDED."updatedAt"
            WHERE "StripeUsageEvent"."status" IN ('PENDING', 'FAILED')
            ''',
            (
                str(uuid.uuid4()), tenant_id, period_start, period_end, quantity, event_name,
                str(tenant[0]), identifier, idempotency_key, now,
                json.dumps({
                    "source": "worker.billing_usage",
                    "aggregation": "active_staff_periodic_snapshot",
                    "logicalUsageIdentity": identifier,
                    "snapshotIntervalSeconds": snapshot_interval_seconds(),
                }),
                now, now,
            ),
        )

    def _update_event(self, event: UsageEvent, sql: str, params: Any) -> None:
        psycopg = self._psycopg()
        with psycopg.connect(self.database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (event.tenant_id,))
                cursor.execute(sql, params(datetime.now(timezone.utc)))

    @staticmethod
    def _psycopg() -> Any:
        try:
            import psycopg
        except ImportError as exc:
            raise RetryableBillingError("psycopg is required for billing usage dispatch") from exc
        return psycopg


class StripeMeterClient:
    def __init__(self, secret_key: str | None = None, api_base: str | None = None):
        self.secret_key = (secret_key or os.getenv("STRIPE_SECRET_KEY", "")).strip()
        self.api_base = (api_base or os.getenv("STRIPE_API_BASE", "https://api.stripe.com")).rstrip("/")
        if not self.secret_key:
            raise NonRetryableBillingError("STRIPE_SECRET_KEY is required for billing usage dispatch")

    def send(self, event: UsageEvent) -> StripeMeterResult:
        body = urlencode({
            "event_name": event.event_name,
            "payload[stripe_customer_id]": event.stripe_customer_id,
            "payload[value]": str(event.quantity),
            "identifier": event.identifier,
            "timestamp": str(int(event.timestamp.astimezone(timezone.utc).timestamp())),
        }).encode("ascii")
        request = Request(
            f"{self.api_base}/v1/billing/meter_events",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {self.secret_key}",
                "Content-Type": "application/x-www-form-urlencoded",
                "Idempotency-Key": event.idempotency_key,
                "User-Agent": "LunchLineup-Worker/1.0",
            },
        )
        try:
            with urlopen(request, timeout=20) as response:
                payload = json.loads(response.read(1_048_576).decode("utf-8"))
                return StripeMeterResult(
                    object_id=payload.get("identifier") if isinstance(payload.get("identifier"), str) else None,
                    request_id=response.headers.get("Request-Id"),
                )
        except HTTPError as exc:
            message = f"Stripe meter event request failed with HTTP {exc.code}"
            should_retry = exc.headers.get("Stripe-Should-Retry") if exc.headers else None
            if exc.code in RETRYABLE_HTTP_STATUSES or should_retry == "true":
                raise RetryableBillingError(message) from exc
            raise NonRetryableBillingError(message) from exc
        except (URLError, TimeoutError, OSError) as exc:
            raise RetryableBillingError("Stripe meter event request failed") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RetryableBillingError("Stripe meter event returned an invalid response") from exc


async def dispatch_usage(
    payload: dict[str, Any],
    store: UsageStore | None = None,
    client: MeterClient | None = None,
) -> dict[str, Any]:
    if not metered_usage_enabled():
        raise NonRetryableBillingError("Stripe metered usage is disabled")
    tenant_id = _identifier(payload.get("tenant_id"), "tenant_id")
    usage_event_id = _optional_identifier(payload.get("usage_event_id"), "usage_event_id")
    store = store or PostgresUsageStore()
    client = client or StripeMeterClient()
    event = await asyncio.to_thread(store.claim, tenant_id, usage_event_id)
    if event is None:
        return {"skipped": True, "tenant_id": tenant_id}

    try:
        result = await asyncio.to_thread(client.send, event)
        await asyncio.to_thread(store.mark_sent, event, result)
        return {
            "sent": True,
            "usage_event_id": event.id,
            "identifier": event.identifier,
            "attempts": event.attempts,
        }
    except (RetryableBillingError, NonRetryableBillingError) as exc:
        max_attempts = int_env("STRIPE_USAGE_MAX_ATTEMPTS", 5, 1, 20)
        dead_lettered = isinstance(exc, NonRetryableBillingError) or event.attempts >= max_attempts
        await asyncio.to_thread(store.mark_failed, event, str(exc), dead_lettered)
        if dead_lettered:
            raise NonRetryableBillingError("Stripe usage event was dead-lettered") from exc
        raise


async def run_billing_usage_cycle(store: UsageStore | None = None, client: MeterClient | None = None) -> dict[str, int]:
    if not metered_usage_enabled():
        return {"processed": 0, "failed": 0, "requeued": 0}
    store = store or PostgresUsageStore()
    client = client or StripeMeterClient()
    recovery_limit = int_env("STRIPE_USAGE_SWEEP_BATCH_SIZE", 100, 1, 1000)
    terminalized = await asyncio.to_thread(store.terminalize_expired_final_attempts, recovery_limit)
    if terminalized:
        logger.error("Billing usage final-attempt leases terminalized=%s outcome=unknown", terminalized)
    requeued = 0
    if dead_letter_replay_enabled():
        replay_limit = int_env("STRIPE_USAGE_DEAD_LETTER_REPLAY_BATCH_SIZE", 25, 1, 100)
        requeued = await asyncio.to_thread(store.requeue_dead_lettered, replay_limit)
        if requeued:
            logger.warning("Billing usage dead-letter replay requeued=%s", requeued)
    limit = recovery_limit
    tenant_ids = await asyncio.to_thread(store.list_due_tenant_ids, limit)
    processed = 0
    failed = 0
    for tenant_id in tenant_ids:
        try:
            result = await dispatch_usage({"tenant_id": tenant_id}, store=store, client=client)
            if result.get("sent"):
                processed += 1
        except (RetryableBillingError, NonRetryableBillingError) as exc:
            failed += 1
            logger.warning("Billing usage cycle failed tenant_ref=%s reason=%s", _safe_ref(tenant_id), exc.__class__.__name__)
    return {"processed": processed, "failed": failed, "requeued": requeued}


async def run_billing_usage_loop() -> None:
    interval = int_env("STRIPE_USAGE_SWEEP_INTERVAL_SECONDS", 60, 10, 3600)
    while True:
        try:
            result = await run_billing_usage_cycle()
            if result["processed"] or result["failed"] or result["requeued"]:
                logger.info(
                    "Billing usage sweep processed=%s failed=%s requeued=%s",
                    result["processed"],
                    result["failed"],
                    result["requeued"],
                )
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.error("Billing usage sweep failed reason=%s", exc.__class__.__name__)
        await asyncio.sleep(interval)


def _identifier(value: Any, field: str) -> str:
    if not isinstance(value, str) or not IDENTIFIER_PATTERN.fullmatch(value.strip()):
        raise NonRetryableBillingError(f"{field} is invalid")
    return value.strip()


def _optional_identifier(value: Any, field: str) -> str | None:
    if value is None:
        return None
    return _identifier(value, field)


def _safe_ref(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
