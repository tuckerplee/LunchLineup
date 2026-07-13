from __future__ import annotations

from datetime import datetime, timedelta, timezone
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.parse import parse_qs

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

from src import billing_usage  # noqa: E402


def usage_event(attempts: int = 1, tenant_id: str = "tenant-1") -> billing_usage.UsageEvent:
    event_suffix = "1" if tenant_id == "tenant-1" else tenant_id
    return billing_usage.UsageEvent(
        id=f"usage-{event_suffix}",
        tenant_id=tenant_id,
        event_name="active_staff",
        stripe_customer_id="cus_123" if tenant_id == "tenant-1" else f"cus_{event_suffix}",
        quantity=14,
        identifier=f"ll_active_staff_20260709_{event_suffix}",
        idempotency_key=f"stripe_usage_ll_active_staff_20260709_{event_suffix}",
        timestamp=datetime(2026, 7, 9, tzinfo=timezone.utc),
        attempts=attempts,
    )


class FakeStore:
    def __init__(self, claims):
        self.claims = list(claims)
        self.sent = []
        self.failed = []
        self.claim_calls = []
        self.requeue_calls = []
        self.terminalize_calls = []

    def claim(self, tenant_id, usage_event_id=None):
        self.claim_calls.append((tenant_id, usage_event_id))
        return self.claims.pop(0) if self.claims else None

    def mark_sent(self, event, result):
        self.sent.append((event, result))

    def mark_failed(self, event, message, dead_lettered):
        self.failed.append((event, message, dead_lettered))

    def list_due_tenant_ids(self, limit):
        return ["tenant-1"][:limit]

    def terminalize_expired_final_attempts(self, limit):
        self.terminalize_calls.append(limit)
        return 0

    def requeue_dead_lettered(self, limit):
        self.requeue_calls.append(limit)
        return 0


class FakeClient:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.events = []

    def send(self, event):
        self.events.append(event)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeStripeResponse:
    def __init__(self):
        self.headers = {"Request-Id": "req_123"}

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, _limit):
        return b'{"identifier":"ll_active_staff_20260709_abc"}'


class QueryCursor:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchall(self):
        return self.rows


class SnapshotCursor(QueryCursor):
    def __init__(self, fetchone_rows):
        super().__init__([])
        self.fetchone_rows = list(fetchone_rows)

    def fetchone(self):
        return self.fetchone_rows.pop(0)


class QueryConnection:
    def __init__(self, cursor):
        self._cursor = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def cursor(self):
        return self._cursor


class QueryPsycopg:
    def __init__(self, cursor):
        self._cursor = cursor

    def connect(self, _database_url):
        return QueryConnection(self._cursor)


class FairSweepStore:
    def __init__(self, tenant_ids):
        self.tenant_ids = list(tenant_ids)
        self.sent = set()
        self.batches = []

    def list_due_tenant_ids(self, limit):
        batch = [tenant_id for tenant_id in self.tenant_ids if tenant_id not in self.sent][:limit]
        self.batches.append(batch)
        return batch

    def claim(self, tenant_id, usage_event_id=None):
        if tenant_id in self.sent:
            return None
        return usage_event(tenant_id=tenant_id)

    def mark_sent(self, event, _result):
        self.sent.add(event.tenant_id)

    def mark_failed(self, _event, _message, _dead_lettered):
        raise AssertionError("fair sweep test does not expect delivery failures")

    def requeue_dead_lettered(self, _limit):
        return 0

    def terminalize_expired_final_attempts(self, _limit):
        return 0


class BillingUsageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "STRIPE_METERED_USAGE_ENABLED": "true",
            "STRIPE_METER_AGGREGATION": "last",
            "STRIPE_USAGE_MAX_ATTEMPTS": "5",
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "unit-test-platform-admin-capability",
        }, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)

    async def test_dispatch_marks_a_claimed_event_sent(self):
        event = usage_event()
        store = FakeStore([event])
        client = FakeClient([billing_usage.StripeMeterResult("meter-event-1", "req_123")])

        result = await billing_usage.dispatch_usage(
            {"tenant_id": "tenant-1", "usage_event_id": "usage-1"},
            store=store,
            client=client,
        )

        self.assertTrue(result["sent"])
        self.assertEqual(store.claim_calls, [("tenant-1", "usage-1")])
        self.assertEqual(store.sent[0][0].idempotency_key, event.idempotency_key)
        self.assertEqual(client.events[0].identifier, event.identifier)

    async def test_retryable_failure_stays_durable_and_reuses_the_same_identity(self):
        first = usage_event(attempts=1)
        second = usage_event(attempts=2)
        store = FakeStore([first, second])
        client = FakeClient([
            billing_usage.RetryableBillingError("temporary"),
            billing_usage.StripeMeterResult("meter-event-1", "req_456"),
        ])

        with self.assertRaises(billing_usage.RetryableBillingError):
            await billing_usage.dispatch_usage({"tenant_id": "tenant-1"}, store=store, client=client)
        result = await billing_usage.dispatch_usage({"tenant_id": "tenant-1"}, store=store, client=client)

        self.assertFalse(store.failed[0][2])
        self.assertTrue(result["sent"])
        self.assertEqual(client.events[0].identifier, client.events[1].identifier)
        self.assertEqual(client.events[0].idempotency_key, client.events[1].idempotency_key)

    async def test_non_retryable_failure_dead_letters_the_durable_event(self):
        store = FakeStore([usage_event()])
        client = FakeClient([billing_usage.NonRetryableBillingError("invalid request")])

        with self.assertRaises(billing_usage.NonRetryableBillingError):
            await billing_usage.dispatch_usage({"tenant_id": "tenant-1"}, store=store, client=client)

        self.assertTrue(store.failed[0][2])

    async def test_duplicate_or_not_due_event_is_skipped_without_calling_stripe(self):
        store = FakeStore([None])
        client = FakeClient([])

        result = await billing_usage.dispatch_usage({"tenant_id": "tenant-1"}, store=store, client=client)

        self.assertEqual(result, {"skipped": True, "tenant_id": "tenant-1"})
        self.assertEqual(client.events, [])

    def test_snapshot_identity_is_stable_for_the_tenant_and_utc_bucket(self):
        now = datetime(2026, 7, 9, 19, 30, tzinfo=timezone.utc)

        first = billing_usage.usage_snapshot_identity("tenant-1", now)
        second = billing_usage.usage_snapshot_identity("tenant-1", now)

        self.assertEqual(first, second)
        self.assertTrue(first[0].startswith("ll_active_staff_20260709T193000Z_"))
        self.assertEqual(first[1], f"stripe_usage_{first[0]}")

    def test_snapshot_period_floors_to_configured_interval(self):
        now = datetime(2026, 7, 9, 19, 32, 47, tzinfo=timezone.utc)
        with patch.dict(os.environ, {"STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS": "300"}, clear=False):
            start, end = billing_usage.snapshot_period(now)

        self.assertEqual(start, datetime(2026, 7, 9, 19, 30, tzinfo=timezone.utc))
        self.assertEqual(end - start, timedelta(minutes=5))

    def test_snapshot_upserts_by_immutable_period_without_resetting_transport_identity(self):
        now = datetime(2026, 7, 9, 19, 32, 47, tzinfo=timezone.utc)
        cursor = SnapshotCursor([("cus_123",), (14,)])
        store = billing_usage.PostgresUsageStore("postgresql://worker@example/lunchlineup")

        with patch.dict(os.environ, {
            "STRIPE_METER_EVENT_NAME": "active_staff",
            "STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS": "300",
        }, clear=False):
            store._prepare_usage_snapshot(cursor, "tenant-1", now)

        query, params = next(call for call in cursor.calls if 'INSERT INTO "StripeUsageEvent"' in call[0])
        normalized = " ".join(query.split())
        conflict_update = normalized.split("DO UPDATE SET", 1)[1]
        self.assertIn(
            'ON CONFLICT ("tenantId", "metric", "periodStart", "periodEnd") DO UPDATE SET',
            normalized,
        )
        self.assertIn('"quantity" = EXCLUDED."quantity"', conflict_update)
        self.assertIn('WHERE "StripeUsageEvent"."status" IN (\'PENDING\', \'FAILED\')', conflict_update)
        self.assertNotIn('"identifier" =', conflict_update)
        self.assertNotIn('"idempotencyKey" =', conflict_update)
        self.assertEqual(params[1], "tenant-1")
        self.assertEqual(params[2], datetime(2026, 7, 9, 19, 30, tzinfo=timezone.utc))
        self.assertEqual(params[3], datetime(2026, 7, 9, 19, 35, tzinfo=timezone.utc))

    def test_enabled_metering_requires_database_stripe_key_and_event_name(self):
        with patch.dict(os.environ, {
            "STRIPE_METERED_USAGE_ENABLED": "true",
            "DATABASE_URL": "postgresql://worker@example/lunchlineup",
            "STRIPE_SECRET_KEY": "",
            "STRIPE_METER_EVENT_NAME": "active_staff",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "STRIPE_SECRET_KEY"):
                billing_usage.validate_billing_runtime_config()

    def test_enabled_metering_requires_last_value_aggregation(self):
        with patch.dict(os.environ, {
            "STRIPE_METERED_USAGE_ENABLED": "true",
            "DATABASE_URL": "postgresql://worker@example/lunchlineup",
            "STRIPE_SECRET_KEY": "sk_test_123",
            "STRIPE_METER_EVENT_NAME": "active_staff",
            "STRIPE_METER_AGGREGATION": "sum",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be last"):
                billing_usage.validate_billing_runtime_config()

    async def test_periodic_cycle_drains_due_tenants(self):
        store = FakeStore([usage_event()])
        client = FakeClient([billing_usage.StripeMeterResult("meter-event-1", "req_789")])

        result = await billing_usage.run_billing_usage_cycle(store=store, client=client)

        self.assertEqual(result, {"processed": 1, "failed": 0, "requeued": 0})

    async def test_dead_letter_replay_is_operator_gated_and_observable(self):
        store = FakeStore([usage_event()])
        store.requeue_dead_lettered = lambda limit: store.requeue_calls.append(limit) or 1
        client = FakeClient([billing_usage.StripeMeterResult("meter-event-1", "req_replay")])

        with patch.dict(os.environ, {
            "STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED": "true",
            "STRIPE_USAGE_DEAD_LETTER_REPLAY_BATCH_SIZE": "7",
        }, clear=False), self.assertLogs("worker.billing_usage", level="WARNING") as logs:
            result = await billing_usage.run_billing_usage_cycle(store=store, client=client)

        self.assertEqual(result, {"processed": 1, "failed": 0, "requeued": 1})
        self.assertEqual(store.requeue_calls, [7])
        self.assertIn("dead-letter replay requeued=1", " ".join(logs.output))

    async def test_periodic_cycle_terminalizes_expired_final_attempt_before_replay(self):
        store = FakeStore([])
        store.terminalize_expired_final_attempts = lambda limit: store.terminalize_calls.append(limit) or 1
        client = FakeClient([])

        with patch.dict(os.environ, {
            "STRIPE_USAGE_SWEEP_BATCH_SIZE": "9",
            "STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED": "false",
        }, clear=False), self.assertLogs("worker.billing_usage", level="ERROR") as logs:
            result = await billing_usage.run_billing_usage_cycle(store=store, client=client)

        self.assertEqual(result, {"processed": 0, "failed": 0, "requeued": 0})
        self.assertEqual(store.terminalize_calls, [9])
        self.assertIn("final-attempt leases terminalized=1 outcome=unknown", " ".join(logs.output))

    def test_expired_final_attempt_is_atomically_dead_lettered_without_changing_stripe_identity(self):
        cursor = QueryCursor([("usage-final",)])
        store = billing_usage.PostgresUsageStore("postgresql://worker@example/lunchlineup")

        with patch.object(store, "_psycopg", return_value=QueryPsycopg(cursor)):
            terminalized = store.terminalize_expired_final_attempts(4)

        self.assertEqual(terminalized, 1)
        query, params = next(call for call in cursor.calls if "WITH expired AS" in call[0])
        normalized = " ".join(query.split())
        self.assertIn('"status" = \'SENDING\'', normalized)
        self.assertIn('"attempts" >= %s', normalized)
        self.assertIn('"updatedAt" <= %s', normalized)
        self.assertIn('FOR UPDATE SKIP LOCKED LIMIT %s', normalized)
        self.assertIn('SET "status" = \'DEAD_LETTERED\'', normalized)
        self.assertIn("finalAttemptOutcome", normalized)
        self.assertNotIn('"identifier" =', normalized)
        self.assertNotIn('"idempotencyKey" =', normalized)
        self.assertEqual(params[0], store.max_attempts)
        self.assertEqual(params[2], 4)
        self.assertEqual(params[-1], store.max_attempts)
        self.assertGreaterEqual(datetime.now(timezone.utc) - params[1], timedelta(seconds=store.lease_seconds))

    async def test_dead_letter_replay_is_disabled_by_default(self):
        store = FakeStore([usage_event()])
        client = FakeClient([billing_usage.StripeMeterResult("meter-event-1", "req_normal")])

        with patch.dict(os.environ, {"STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED": "false"}, clear=False):
            result = await billing_usage.run_billing_usage_cycle(store=store, client=client)

        self.assertEqual(result["requeued"], 0)
        self.assertEqual(store.requeue_calls, [])

    def test_dead_letter_requeue_is_bounded_atomic_and_rotates_both_transport_identities(self):
        cursor = QueryCursor([("usage-1",), ("usage-2",)])
        store = billing_usage.PostgresUsageStore("postgresql://worker@example/lunchlineup")

        with patch.dict(os.environ, {
            "STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED": "true",
            "STRIPE_USAGE_DEAD_LETTER_REPLAY_MIN_AGE_SECONDS": "1800",
            "STRIPE_USAGE_DEAD_LETTER_MAX_REPLAYS": "2",
        }, clear=False), patch.object(store, "_psycopg", return_value=QueryPsycopg(cursor)):
            requeued = store.requeue_dead_lettered(3)

        self.assertEqual(requeued, 2)
        query, params = next(call for call in cursor.calls if "WITH replayable AS" in call[0])
        normalized = " ".join(query.split())
        self.assertIn('"status" = \'DEAD_LETTERED\'', normalized)
        self.assertIn('"updatedAt" <= %s', normalized)
        self.assertIn('deadLetterReplayCount', normalized)
        self.assertIn('FOR UPDATE SKIP LOCKED LIMIT %s', normalized)
        self.assertIn('SET "status" = \'FAILED\', "attempts" = 0', normalized)
        self.assertIn('"identifier" = \'ll_replay_\' || md5(', normalized)
        self.assertIn('"idempotencyKey" = \'stripe_usage_replay_\' || md5(', normalized)
        self.assertIn("logicalUsageIdentity", normalized)
        self.assertIn("deadLetterPreviousIdentifier", normalized)
        self.assertIn("deadLetterPreviousIdempotencyKey", normalized)
        self.assertIn("operator_replay_fresh_transport", normalized)
        self.assertEqual(params[1:3], (2, 3))
        self.assertGreaterEqual(datetime.now(timezone.utc) - params[0], timedelta(minutes=30))

    def test_operator_replay_fails_closed_without_last_value_aggregation(self):
        store = billing_usage.PostgresUsageStore("postgresql://worker@example/lunchlineup")

        with patch.dict(os.environ, {
            "STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED": "true",
            "STRIPE_METER_AGGREGATION": "sum",
        }, clear=False):
            with self.assertRaisesRegex(billing_usage.NonRetryableBillingError, "must be last"):
                store.requeue_dead_lettered(1)

    def test_sweep_query_prioritizes_due_retries_and_excludes_current_snapshots(self):
        cursor = QueryCursor([("tenant-retry",), ("tenant-new",)])
        store = billing_usage.PostgresUsageStore("postgresql://worker@example/lunchlineup")

        with patch.object(store, "_psycopg", return_value=QueryPsycopg(cursor)):
            tenant_ids = store.list_due_tenant_ids(2)

        self.assertEqual(tenant_ids, ["tenant-retry", "tenant-new"])
        query, params = next(call for call in cursor.calls if "WITH due_retries AS" in call[0])
        normalized = " ".join(query.split())
        self.assertIn("usage.\"status\" IN ('PENDING', 'FAILED')", normalized)
        self.assertIn("0 AS priority", normalized)
        self.assertIn("1 AS priority", normalized)
        self.assertLess(normalized.index("0 AS priority"), normalized.index("1 AS priority"))
        self.assertIn("NOT EXISTS ( SELECT 1 FROM \"StripeUsageEvent\" current_snapshot", normalized)
        self.assertIn("current_snapshot.\"periodStart\" = %s", normalized)
        self.assertIn("COALESCE(MAX(history.\"periodStart\"), TIMESTAMP '-infinity')", normalized)
        self.assertIn("ORDER BY candidates.priority, candidates.\"sortAt\", candidates.\"tenantId\"", normalized)
        self.assertEqual(params[0], store.max_attempts)
        self.assertEqual(params[-1], 2)
        self.assertEqual(params[4] - params[3], timedelta(minutes=5))

    async def test_sweep_progresses_every_tenant_across_batches_larger_than_the_limit(self):
        tenant_ids = [f"tenant-{index}" for index in range(1, 6)]
        store = FairSweepStore(tenant_ids)
        client = FakeClient([
            billing_usage.StripeMeterResult(f"meter-event-{index}", f"req_{index}")
            for index in range(1, 6)
        ])

        with patch.dict(os.environ, {"STRIPE_USAGE_SWEEP_BATCH_SIZE": "2"}, clear=False):
            results = [
                await billing_usage.run_billing_usage_cycle(store=store, client=client)
                for _ in range(3)
            ]

        self.assertEqual(store.batches, [
            ["tenant-1", "tenant-2"],
            ["tenant-3", "tenant-4"],
            ["tenant-5"],
        ])
        self.assertEqual([result["processed"] for result in results], [2, 2, 1])
        self.assertEqual([event.tenant_id for event in client.events], tenant_ids)

    def test_stripe_client_resubmits_with_the_rotated_identifier_and_http_key(self):
        captured = {}

        def open_request(request, timeout):
            captured["request"] = request
            captured["timeout"] = timeout
            return FakeStripeResponse()

        original = usage_event()
        replay = billing_usage.UsageEvent(
            **{
                **original.__dict__,
                "identifier": "ll_replay_0123456789abcdef0123456789abcdef",
                "idempotency_key": "stripe_usage_replay_fedcba9876543210fedcba9876543210",
            }
        )
        client = billing_usage.StripeMeterClient(secret_key="sk_test_123")
        with patch.object(billing_usage, "urlopen", side_effect=open_request):
            result = client.send(replay)

        request = captured["request"]
        payload = parse_qs(request.data.decode("ascii"))
        self.assertEqual(request.full_url, "https://api.stripe.com/v1/billing/meter_events")
        self.assertEqual(request.get_header("Idempotency-key"), replay.idempotency_key)
        self.assertNotEqual(request.get_header("Idempotency-key"), original.idempotency_key)
        self.assertEqual(payload["event_name"], ["active_staff"])
        self.assertEqual(payload["payload[stripe_customer_id]"], ["cus_123"])
        self.assertEqual(payload["payload[value]"], ["14"])
        self.assertEqual(payload["identifier"], [replay.identifier])
        self.assertNotEqual(payload["identifier"], [original.identifier])
        self.assertEqual(payload["timestamp"], [str(int(original.timestamp.timestamp()))])
        self.assertEqual(result.request_id, "req_123")
