"""Native database billing contracts B1 through B6 and B8; admitted execution only.

This filename intentionally is not discovered by the ordinary unit suite.
Run only as a separate qualified native job with --target-receipt. Missing
admission/target evidence fails; it never becomes a passing skipped test.
No execution, syntax parsing, or DB/provider qualification has been performed.
B7 remains a separate unfinished cross-owner contract.
"""
from __future__ import annotations

import argparse
from contextlib import ExitStack
from datetime import timedelta
import os
import sys
import time
import unittest
from unittest.mock import patch

from _billing_native_target import (
    API_BASE, BASE_ENV, EPOCH_A, Fixture, Target, instant, payload_view, utc_naive,
    NoEgressTransport,
)

from _billing_native_transactions import (
    ControlledTransactionRollback, TransactionProbe, DelegatedDriver,
    delegated_prepare, observe_real_lock, owned_native_jobs,
)

TARGET_RECEIPT = None


class BillingUsageStatefulTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        if TARGET_RECEIPT is None:
            raise RuntimeError("Explicit owner-admitted --target-receipt is required")
        cls.target = Target(TARGET_RECEIPT)
        cls.target.verify()
        cls.loaded_name, cls.billing = cls.target.load_worker()
        cls.addClassCleanup(sys.modules.pop, cls.loaded_name, None)

    def setUp(self):
        stack = ExitStack()
        self.addCleanup(stack.close)
        # Restore the process-local timezone after restoring the environment.
        stack.callback(time.tzset)
        env = dict(BASE_ENV)
        env["PLATFORM_ADMIN_DB_CONTEXT_SECRET"] = self.target.receipt["platformCapability"]
        stack.enter_context(patch.dict(os.environ, env, clear=True))
        time.tzset()
        self.fixture = Fixture(self.target, self.billing)
        stack.enter_context(self.fixture.clock.patch)
        # Registered before setup SQL so partial seed failures also clean exactly
        # owned IDs while clock/environment/capability remain in scope.
        stack.callback(self.fixture.cleanup)

    def assert_request(self, transport, index, row, quantity=3, name="fixture_staff_A",
                       customer=None, epoch=EPOCH_A):
        captured = transport.captures[index]
        expected_customer = customer or "fixture_customer_A_" + row["tenantId"]
        self.assertEqual(captured["url"], API_BASE + "/v1/billing/meter_events")
        self.assertEqual(captured["method"], "POST")
        self.assertEqual(captured["content_type"], "application/x-www-form-urlencoded")
        self.assertEqual(captured["agent"], "LunchLineup-Worker/1.0")
        self.assertEqual(captured["timeout"], 20)
        self.assertEqual(captured["key"], row["idempotencyKey"])
        # Manual oracle first; body equality alone can accept two wrong requests.
        self.assertEqual(transport.decoded(index), {
            "event_name": [name],
            "payload[stripe_customer_id]": [expected_customer],
            "payload[value]": [str(quantity)],
            "identifier": [row["identifier"]],
            "timestamp": [str(epoch)],
        })

    def test_same_interval_unknown_result_preserves_all_payload_drift_variants(self):
        for fields in ({"count"}, {"customer"}, {"name"}, {"count", "customer", "name"}):
            with self.subTest(fields=sorted(fields)):
                os.environ["STRIPE_METER_EVENT_NAME"] = "fixture_staff_A"
                self.fixture.clock.at("2026-07-09T19:30:10Z")
                tenant = self.fixture.seed()
                store = self.fixture.store()
                transport = NoEgressTransport(["timeout", "success"])
                with self.assertRaises(self.billing.RetryableBillingError):
                    self.fixture.dispatch(tenant, store, transport)
                initial = self.fixture.one(tenant)
                self.assertEqual((initial["quantity"], initial["eventName"],
                                  initial["stripeCustomerId"]),
                                 (3, "fixture_staff_A", "fixture_customer_A_" + tenant))
                self.assertEqual(initial["periodStart"],
                                 utc_naive(instant("2026-07-09T19:30:00Z")))
                self.assertEqual(initial["periodEnd"],
                                 utc_naive(instant("2026-07-09T19:35:00Z")))
                self.assertEqual(initial["status"], "FAILED")
                self.assertEqual(initial["attempts"], 1)
                self.assertEqual(initial["submittedAt"],
                                 utc_naive(instant("2026-07-09T19:30:10Z")))
                self.assertEqual(initial["nextAttemptAt"],
                                 utc_naive(instant("2026-07-09T19:32:10Z")))
                self.assertEqual(initial["lastError"], "STRIPE_USAGE_RETRYABLE")
                self.assert_request(transport, 0, initial)
                self.fixture.clock.at("2026-07-09T19:30:20Z")
                self.fixture.drift(tenant, fields)
                self.assertIsNone(store.claim(tenant))
                # Actual preparation executed; backoff was not bypassed or edited.
                before_due = self.fixture.one(tenant)
                self.assertEqual(before_due, initial)
                self.assertEqual(len(transport.captures), 1)
                self.fixture.clock.at("2026-07-09T19:32:11Z")
                result = self.fixture.dispatch(tenant, store, transport)
                self.assertTrue(result["sent"])
                sent = self.fixture.one(tenant)
                self.assertEqual(payload_view(sent), payload_view(initial))
                self.assertEqual(sent["attempts"], 2)
                self.assertEqual(sent["status"], "SENT")
                self.assertEqual(sent["submittedAt"],
                                 utc_naive(instant("2026-07-09T19:32:11Z")))
                self.assertEqual(sent["sentAt"],
                                 utc_naive(instant("2026-07-09T19:32:11Z")))
                self.assertEqual(sent["stripeObjectId"], "synthetic-result")
                self.assertEqual(sent["stripeRequestId"], "synthetic-request")
                self.assertIsNone(sent["lastError"])
                self.assert_request(transport, 1, sent)
                self.assertEqual(transport.captures[1]["body"],
                                 transport.captures[0]["body"])
                self.assertEqual(transport.captures[1]["key"],
                                 transport.captures[0]["key"])
                self.assertEqual(len(transport.captures), 2)
                self.assertEqual(transport.outcomes, [])

    def test_preparation_eight_persisted_states_refreshes_only_never_claimed(self):
        matrix = (
            ("PENDING", 0, False, True),
            ("PENDING", 0, True, False),
            ("PENDING", 1, False, False),
            ("FAILED", 1, False, False),
            ("FAILED", 0, False, False),
            ("SENDING", 1, True, False),
            ("SENT", 1, True, False),
            ("DEAD_LETTERED", 1, True, False),
        )
        for status, attempts, submitted, refresh in matrix:
            with self.subTest(status=status, attempts=attempts, submitted=submitted):
                os.environ["STRIPE_METER_EVENT_NAME"] = "fixture_staff_A"
                self.fixture.clock.at("2026-07-09T19:30:10Z")
                tenant = self.fixture.seed()
                store = self.fixture.store()
                self.fixture.prepare(store, tenant)
                original = self.fixture.one(tenant)
                with self.fixture.context(tenant) as cursor:
                    cursor.execute(
                        'UPDATE "StripeUsageEvent" SET "status"=%s::"StripeUsageEventStatus",'
                        '"attempts"=%s,"submittedAt"=%s WHERE "id"=%s AND "tenantId"=%s',
                        (status, attempts,
                         utc_naive(self.fixture.clock.current) if submitted else None,
                         original["id"], tenant),
                    )
                before = self.fixture.one(tenant)
                self.fixture.clock.at("2026-07-09T19:30:20Z")
                self.fixture.drift(tenant, {"count", "customer", "name"})
                self.fixture.prepare(store, tenant)
                after = self.fixture.one(tenant)
                if refresh:
                    expected = dict(before)
                    expected.update({
                        "quantity": 4, "eventName": "fixture_staff_B",
                        "stripeCustomerId": "fixture_customer_B_" + tenant,
                        "updatedAt": utc_naive(self.fixture.clock.current),
                    })
                    self.assertEqual(after, expected)
                else:
                    self.assertEqual(after, before)
                # SQL row observation is independent of production WHERE text.
                self.assertEqual(len(self.fixture.rows(tenant)), 1)

    def test_never_claimed_pending_refreshes_before_first_handoff(self):
        tenant = self.fixture.seed()
        store = self.fixture.store()
        self.fixture.prepare(store, tenant)
        pending = self.fixture.one(tenant)
        self.assertEqual((pending["status"], pending["attempts"], pending["submittedAt"]),
                         ("PENDING", 0, None))
        self.fixture.clock.at("2026-07-09T19:30:20Z")
        self.fixture.drift(tenant, {"count", "customer", "name"})
        transport = NoEgressTransport(["success"])
        self.assertTrue(self.fixture.dispatch(tenant, store, transport)["sent"])
        sent = self.fixture.one(tenant)
        for name in ("id", "identifier", "idempotencyKey", "periodStart", "periodEnd"):
            self.assertEqual(sent[name], pending[name])
        self.assertEqual(sent["status"], "SENT")
        self.assertEqual(sent["attempts"], 1)
        self.assertEqual(sent["quantity"], 4)
        self.assert_request(transport, 0, sent, quantity=4, name="fixture_staff_B",
                            customer="fixture_customer_B_" + tenant)
        self.assertEqual(len(transport.captures), 1)
        self.assertEqual(transport.outcomes, [])

    def test_new_interval_uses_current_values_and_preserves_attempted_prior_tuple(self):
        tenant = self.fixture.seed()
        store = self.fixture.store()
        transport = NoEgressTransport(["success", "success"])
        self.assertTrue(self.fixture.dispatch(tenant, store, transport)["sent"])
        initial = self.fixture.one(tenant)
        self.assert_request(transport, 0, initial)
        self.fixture.clock.at("2026-07-09T19:30:20Z")
        self.fixture.drift(tenant, {"count", "customer", "name"})
        self.fixture.clock.at("2026-07-09T19:35:10Z")
        self.assertTrue(self.fixture.dispatch(tenant, store, transport)["sent"])
        old, new = self.fixture.rows(tenant)
        self.assertEqual(old, initial)
        self.assertEqual(new["periodStart"],
                         utc_naive(instant("2026-07-09T19:35:00Z")))
        self.assertEqual(new["periodEnd"],
                         utc_naive(instant("2026-07-09T19:40:00Z")))
        self.assertEqual((new["status"], new["attempts"], new["quantity"]),
                         ("SENT", 1, 4))
        for name in ("id", "identifier", "idempotencyKey"):
            self.assertNotEqual(new[name], old[name])
        self.assert_request(transport, 1, new, quantity=4, name="fixture_staff_B",
                            customer="fixture_customer_B_" + tenant, epoch=EPOCH_A + 300)
        self.assertNotEqual(transport.captures[1]["body"], transport.captures[0]["body"])
        self.assertEqual(len(transport.captures), 2)
        self.assertEqual(transport.outcomes, [])


    def test_operator_replay_preserves_payload_and_rotates_only_transport_identity(self):
        for resend_outcome in ("success", "reject"):
            with self.subTest(resend_outcome=resend_outcome):
                os.environ["STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED"] = "false"
                os.environ["STRIPE_METER_AGGREGATION"] = "last"
                os.environ["STRIPE_METER_EVENT_NAME"] = "fixture_staff_A"
                self.fixture.clock.at("2026-07-09T19:30:10Z")
                tenant = self.fixture.seed()
                store = self.fixture.store()
                first_transport = NoEgressTransport(["reject"])
                with self.assertRaises(self.billing.NonRetryableBillingError):
                    self.fixture.dispatch(tenant, store, first_transport)
                initial = self.fixture.one(tenant)
                self.assertEqual((initial["status"], initial["attempts"]),
                                 ("DEAD_LETTERED", 1))
                self.assertEqual(initial["lastError"], "STRIPE_USAGE_NON_RETRYABLE")
                self.assert_request(first_transport, 0, initial)
                self.assertEqual(initial["submittedAt"],
                                 utc_naive(instant("2026-07-09T19:30:10Z")))

                # Disabled replay and wrong aggregation must reject before driver loading.
                with patch.object(store, "_psycopg", wraps=store._psycopg) as loader:
                    self.assertEqual(store.requeue_dead_lettered(1), 0)
                    os.environ["STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED"] = "true"
                    os.environ["STRIPE_METER_AGGREGATION"] = "sum"
                    with self.assertRaises(self.billing.NonRetryableBillingError):
                        store.requeue_dead_lettered(1)
                    self.assertEqual(loader.call_count, 0)
                os.environ["STRIPE_METER_AGGREGATION"] = "last"
                os.environ["STRIPE_USAGE_DEAD_LETTER_REPLAY_MIN_AGE_SECONDS"] = "60"
                os.environ["STRIPE_USAGE_DEAD_LETTER_MAX_REPLAYS"] = "1"
                self.fixture.clock.at("2026-07-09T19:31:09Z")
                self.assertEqual(store.requeue_dead_lettered(1), 0)
                self.assertEqual(self.fixture.one(tenant), initial)
                self.fixture.clock.at("2026-07-09T19:31:11Z")
                self.assertEqual(store.requeue_dead_lettered(1), 1)
                replay = self.fixture.one(tenant)
                self.assertEqual((replay["status"], replay["attempts"]), ("FAILED", 0))
                for key in ("id", "tenantId", "metric", "periodStart", "periodEnd",
                            "quantity", "eventName", "stripeCustomerId", "createdAt", "submittedAt"):
                    self.assertEqual(replay[key], initial[key])
                self.assertNotEqual(replay["identifier"], initial["identifier"])
                self.assertNotEqual(replay["idempotencyKey"], initial["idempotencyKey"])
                self.assertRegex(replay["identifier"], r"^ll_replay_[a-f0-9]{32}$")
                self.assertRegex(replay["idempotencyKey"], r"^stripe_usage_replay_[a-f0-9]{32}$")
                metadata = replay["metadata"]
                for key, value in initial["metadata"].items():
                    self.assertEqual(metadata[key], value)
                self.assertEqual(metadata["logicalUsageIdentity"], initial["identifier"])
                self.assertEqual(metadata["deadLetterReplayCount"], 1)
                self.assertEqual(metadata["deadLetterPreviousIdentifier"], initial["identifier"])
                self.assertEqual(metadata["deadLetterPreviousIdempotencyKey"],
                                 initial["idempotencyKey"])
                self.assertEqual(metadata["deadLetterPreviousError"], "STRIPE_USAGE_NON_RETRYABLE")
                self.assertEqual(metadata["deadLetterReplayDisposition"], "operator_replay_fresh_transport")
                self.assertEqual(instant(metadata["deadLetterLastReplayedAt"]),
                                 instant("2026-07-09T19:31:11Z"))
                self.assertEqual(replay["nextAttemptAt"],
                                 utc_naive(instant("2026-07-09T19:31:11Z")))

                # Exercise successful replay as well as a second real rejection/count cap.
                self.fixture.clock.at("2026-07-09T19:31:12Z")
                self.fixture.drift(tenant, {"count", "customer", "name"})
                replay_transport = NoEgressTransport([resend_outcome])
                if resend_outcome == "reject":
                    with self.assertRaises(self.billing.NonRetryableBillingError):
                        self.fixture.dispatch(tenant, store, replay_transport)
                else:
                    self.assertTrue(self.fixture.dispatch(tenant, store, replay_transport)["sent"])
                second_result = self.fixture.one(tenant)
                self.assertEqual(payload_view(second_result), payload_view(replay))
                self.assertEqual((second_result["status"], second_result["attempts"]),
                                 ("SENT" if resend_outcome == "success" else "DEAD_LETTERED", 1))
                self.assertEqual(second_result["lastError"],
                                 None if resend_outcome == "success" else "STRIPE_USAGE_NON_RETRYABLE")
                if resend_outcome == "success":
                    self.assertEqual(second_result["sentAt"], utc_naive(self.fixture.clock.current))
                    self.assertEqual(second_result["stripeObjectId"], "synthetic-result")
                    self.assertEqual(second_result["stripeRequestId"], "synthetic-request")
                self.assert_request(replay_transport, 0, second_result)
                self.assertEqual(second_result["submittedAt"],
                                 utc_naive(instant("2026-07-09T19:31:12Z")))
                first_fields = first_transport.decoded(0)
                replay_fields = replay_transport.decoded(0)
                for key in ("event_name", "payload[stripe_customer_id]", "payload[value]", "timestamp"):
                    self.assertEqual(replay_fields[key], first_fields[key])
                self.assertNotEqual(replay_fields["identifier"], first_fields["identifier"])
                self.assertNotEqual(replay_transport.captures[0]["key"],
                                    first_transport.captures[0]["key"])
                self.fixture.clock.at("2026-07-09T19:32:13Z")
                self.assertEqual(store.requeue_dead_lettered(1), 0)
                self.assertEqual(self.fixture.one(tenant), second_result)
                self.assertEqual(len(first_transport.captures), 1)
                self.assertEqual(len(replay_transport.captures), 1)
                self.assertEqual(first_transport.outcomes, [])
                self.assertEqual(replay_transport.outcomes, [])

    def test_explicit_id_retry_skips_preparation_and_wrong_tenant_cannot_read_or_claim(self):
        tenant = self.fixture.seed("owner")
        other = self.fixture.seed("other")
        store = self.fixture.store()
        transport = NoEgressTransport(["timeout", "success"])
        with self.assertRaises(self.billing.RetryableBillingError):
            self.fixture.dispatch(tenant, store, transport)
        initial = self.fixture.one(tenant)
        self.assert_request(transport, 0, initial)
        self.fixture.clock.at("2026-07-09T19:30:20Z")
        self.fixture.drift(tenant, {"count", "customer", "name"})
        self.fixture.clock.at("2026-07-09T19:32:11Z")
        with patch.object(store, "_prepare_usage_snapshot",
                          wraps=store._prepare_usage_snapshot) as prepare:
            self.assertIsNone(store.claim(other, initial["id"]))
            # This inspection deliberately has no tenantId predicate: real RLS
            # and context helpers must hide the owner's row from the other tenant.
            with self.fixture.context(other) as cursor:
                cursor.execute('SELECT "id" FROM "StripeUsageEvent" WHERE "id"=%s',
                               (initial["id"],))
                self.assertEqual(cursor.fetchall(), [])
            self.assertEqual(self.fixture.rows(other), [])
            self.assertEqual(self.fixture.one(tenant), initial)
            result = self.fixture.dispatch(tenant, store, transport, event_id=initial["id"])
            self.assertTrue(result["sent"])
            self.assertEqual(prepare.call_count, 0)
        sent = self.fixture.one(tenant)
        self.assertEqual(payload_view(sent), payload_view(initial))
        self.assertEqual((sent["status"], sent["attempts"]), ("SENT", 2))
        self.assertEqual(sent["submittedAt"],
                         utc_naive(instant("2026-07-09T19:32:11Z")))
        self.assert_request(transport, 1, sent)
        self.assertEqual(transport.captures[1]["body"], transport.captures[0]["body"])
        self.assertEqual(transport.captures[1]["key"], transport.captures[0]["key"])
        self.assertEqual(self.fixture.rows(other), [])
        self.assertEqual(len(transport.captures), 2)
        self.assertEqual(transport.outcomes, [])

    def test_actual_retry_first_finite_sweep_processes_five_tenants_in_three_batches(self):
        prefix = "fixture_" + self.target.receipt["ownerJobId"]
        tenants = [self.fixture.seed("sweep", tenant_id=prefix + "_t0" + str(index))
                   for index in range(1, 6)]
        retry_tenant = tenants[-1]
        fresh = tenants[:-1]
        store = self.fixture.store()
        initial_transport = NoEgressTransport(["timeout"])
        with self.assertRaises(self.billing.RetryableBillingError):
            self.fixture.dispatch(retry_tenant, store, initial_transport)
        initial = self.fixture.one(retry_tenant)
        self.assert_request(initial_transport, 0, initial)
        self.fixture.clock.at("2026-07-09T19:30:20Z")
        self.fixture.drift(retry_tenant, {"count", "customer", "name"})
        self.fixture.clock.at("2026-07-09T19:32:11Z")
        transport = NoEgressTransport(["success"] * 5)
        expected_batches = ([retry_tenant, fresh[0]], fresh[1:3], fresh[3:])
        capture_offset = 0
        for expected_batch in expected_batches:
            with self.subTest(batch=list(expected_batch)):
                self.assertEqual(store.list_due_tenant_ids(2), list(expected_batch))
                result = self.fixture.cycle(store, transport)
                self.assertEqual(result, {"processed": len(expected_batch), "failed": 0,
                                          "requeued": 0})
                new_captures = transport.captures[capture_offset:]
                self.assertEqual(len(new_captures), len(expected_batch))
                for index, tenant in enumerate(expected_batch, start=capture_offset):
                    row = self.fixture.one(tenant)
                    self.assertEqual(row["status"], "SENT")
                    if tenant == retry_tenant:
                        self.assertEqual(payload_view(row), payload_view(initial))
                        self.assertEqual(row["attempts"], 2)
                        self.assert_request(transport, index, row)
                        self.assertEqual(transport.captures[index]["body"],
                                         initial_transport.captures[0]["body"])
                        self.assertEqual(transport.captures[index]["key"],
                                         initial_transport.captures[0]["key"])
                    else:
                        self.assertEqual((row["quantity"], row["eventName"], row["attempts"]),
                                         (3, "fixture_staff_B", 1))
                        self.assert_request(transport, index, row, name="fixture_staff_B")
                capture_offset = len(transport.captures)
        self.assertEqual(store.list_due_tenant_ids(2), [])
        self.assertEqual(len(transport.captures), 5)
        self.assertEqual(transport.outcomes, [])
        self.assertEqual(initial_transport.outcomes, [])
        self.assertEqual(sum(len(self.fixture.rows(tenant)) for tenant in tenants), 5)
        # This fixture proves only its finite backlog if actually executed.
        # Absolute retry priority cannot establish fairness under arbitrary load.



    def finish_claimed_event(self, event, store, transport):
        # Send the actual returned claim once; a second dispatch would re-claim.
        # Dispatch glue is covered separately by B1/B4/B5. This B8 oracle binds
        # committed SQL handoff to actual client bytes without fabricated events.
        with patch.object(self.billing, "urlopen", transport):
            result = self.fixture.client().send(event)
        store.mark_sent(event, result)

    def test_claim_first_blocks_refresh_and_preserves_first_handoff_payload(self):
        tenant = self.fixture.seed("claim_first")
        store = self.fixture.store()
        self.fixture.prepare(store, tenant)
        initial = self.fixture.one(tenant)
        claim_probe = TransactionProbe("claim_update", hold_commit=True)
        refresh_probe = TransactionProbe("snapshot_upsert")
        claim_driver = DelegatedDriver(self.target, claim_probe)
        refresh_driver = DelegatedDriver(self.target, refresh_probe)
        with patch.object(store, "_psycopg", return_value=claim_driver):
            with owned_native_jobs(self.target, claim_driver, refresh_driver) as pool:
                claimed_future = pool.submit(store.claim, tenant)
                self.assertTrue(claim_probe.at_exit.wait(1))
                self.assertFalse(claimed_future.done())
                self.fixture.clock.at("2026-07-09T19:30:20Z")
                self.fixture.drift(tenant, {"count", "customer", "name"})
                refreshed_future = pool.submit(
                    delegated_prepare, self.fixture, store, tenant, refresh_driver,
                )
                lock = observe_real_lock(self.target, refresh_probe, claim_probe)
                self.assertEqual(lock["waitEventType"], "Lock")
                self.assertIn(claim_probe.pid, lock["blockingPids"])
                self.assertFalse(refreshed_future.done())
                # MVCC reader sees pre-handoff committed A while claim is held.
                self.assertEqual(self.fixture.one(tenant), initial)
                claim_probe.release.set()
                claimed = claimed_future.result(timeout=10)
                self.assertIsNone(refreshed_future.result(timeout=10))
        self.assertEqual(claim_probe.exit_kind, "commit")
        self.assertEqual(refresh_probe.exit_kind, "commit")
        self.assertTrue(claim_probe.closed.is_set())
        self.assertTrue(refresh_probe.closed.is_set())
        self.assertIsNotNone(claimed)
        self.assertEqual((claimed.id, claimed.quantity, claimed.event_name,
                          claimed.stripe_customer_id, claimed.attempts),
                         (initial["id"], 3, "fixture_staff_A",
                          "fixture_customer_A_" + tenant, 1))
        handed_off = self.fixture.one(tenant)
        self.assertEqual(payload_view(handed_off), payload_view(initial))
        self.assertEqual((handed_off["status"], handed_off["attempts"]), ("SENDING", 1))
        self.assertEqual(handed_off["submittedAt"],
                         utc_naive(instant("2026-07-09T19:30:10Z")))
        transport = NoEgressTransport(["success"])
        self.finish_claimed_event(claimed, store, transport)
        sent = self.fixture.one(tenant)
        self.assertEqual(payload_view(sent), payload_view(initial))
        self.assertEqual((sent["status"], sent["attempts"]), ("SENT", 1))
        self.assert_request(transport, 0, sent)
        self.assertEqual(len(transport.captures), 1)
        self.assertEqual(transport.outcomes, [])

    def test_refresh_first_blocks_claim_and_first_handoff_uses_current_payload(self):
        tenant = self.fixture.seed("refresh_first")
        store = self.fixture.store()
        self.fixture.prepare(store, tenant)
        initial = self.fixture.one(tenant)
        self.fixture.clock.at("2026-07-09T19:30:20Z")
        self.fixture.drift(tenant, {"count", "customer", "name"})
        refresh_probe = TransactionProbe("snapshot_upsert", hold_commit=True)
        claim_probe = TransactionProbe("claim_update")
        refresh_driver = DelegatedDriver(self.target, refresh_probe)
        claim_driver = DelegatedDriver(self.target, claim_probe)
        with patch.object(store, "_psycopg", return_value=claim_driver):
            with owned_native_jobs(self.target, refresh_driver, claim_driver) as pool:
                refreshed_future = pool.submit(
                    delegated_prepare, self.fixture, store, tenant, refresh_driver,
                )
                self.assertTrue(refresh_probe.at_exit.wait(1))
                self.assertFalse(refreshed_future.done())
                claimed_future = pool.submit(store.claim, tenant)
                lock = observe_real_lock(self.target, claim_probe, refresh_probe)
                self.assertEqual(lock["waitEventType"], "Lock")
                self.assertIn(refresh_probe.pid, lock["blockingPids"])
                self.assertFalse(claimed_future.done())
                # Uncommitted B must not appear to an independent ordinary reader.
                self.assertEqual(self.fixture.one(tenant), initial)
                refresh_probe.release.set()
                self.assertIsNone(refreshed_future.result(timeout=10))
                claimed = claimed_future.result(timeout=10)
        self.assertEqual(refresh_probe.exit_kind, "commit")
        self.assertEqual(claim_probe.exit_kind, "commit")
        self.assertTrue(refresh_probe.closed.is_set())
        self.assertTrue(claim_probe.closed.is_set())
        self.assertIsNotNone(claimed)
        self.assertEqual((claimed.id, claimed.quantity, claimed.event_name,
                          claimed.stripe_customer_id, claimed.attempts),
                         (initial["id"], 4, "fixture_staff_B",
                          "fixture_customer_B_" + tenant, 1))
        handed_off = self.fixture.one(tenant)
        for name in ("id", "identifier", "idempotencyKey", "periodStart", "periodEnd",
                     "metadata", "createdAt"):
            self.assertEqual(handed_off[name], initial[name])
        self.assertEqual((handed_off["status"], handed_off["attempts"]), ("SENDING", 1))
        self.assertEqual(handed_off["submittedAt"],
                         utc_naive(instant("2026-07-09T19:30:20Z")))
        transport = NoEgressTransport(["success"])
        self.finish_claimed_event(claimed, store, transport)
        sent = self.fixture.one(tenant)
        self.assertEqual((sent["status"], sent["attempts"], sent["quantity"]),
                         ("SENT", 1, 4))
        self.assert_request(transport, 0, sent, quantity=4, name="fixture_staff_B",
                            customer="fixture_customer_B_" + tenant)
        self.assertEqual(len(transport.captures), 1)
        self.assertEqual(transport.outcomes, [])

    def test_real_transaction_rollback_leaves_snapshot_unattempted_and_later_claimable(self):
        tenant = self.fixture.seed("rollback")
        store = self.fixture.store()
        self.fixture.prepare(store, tenant)
        initial = self.fixture.one(tenant)
        self.fixture.clock.at("2026-07-09T19:30:20Z")
        self.fixture.drift(tenant, {"count", "customer", "name"})
        rollback_probe = TransactionProbe("claim_update", rollback=True)
        driver = DelegatedDriver(self.target, rollback_probe)
        transport = NoEgressTransport(["success"])
        try:
            with patch.object(store, "_psycopg", return_value=driver):
                with self.assertRaises(ControlledTransactionRollback):
                    self.fixture.dispatch(tenant, store, transport)
        finally:
            # No operation thread remains after Fixture.dispatch executor exit.
            try:
                driver.assert_closed()
            except BaseException:
                self.target.poisoned = True
                raise
        self.assertEqual(rollback_probe.exit_kind, "controlled_rollback")
        self.assertTrue(rollback_probe.at_exit.is_set())
        self.assertIn("snapshot_upsert", rollback_probe.steps)
        self.assertIn("claim_update", rollback_probe.steps)
        self.assertEqual(self.fixture.one(tenant), initial)
        self.assertEqual(transport.captures, [])
        self.assertEqual(transport.outcomes, ["success"])
        # Normal subsequent dispatch must remain possible and refresh pending A
        # to current B. No replacement SQL, forced due time or manufactured claim.
        self.assertTrue(self.fixture.dispatch(tenant, store, transport)["sent"])
        sent = self.fixture.one(tenant)
        for name in ("id", "identifier", "idempotencyKey", "periodStart", "periodEnd",
                     "metadata", "createdAt"):
            self.assertEqual(sent[name], initial[name])
        self.assertEqual((sent["status"], sent["attempts"], sent["quantity"]),
                         ("SENT", 1, 4))
        self.assert_request(transport, 0, sent, quantity=4, name="fixture_staff_B",
                            customer="fixture_customer_B_" + tenant)
        self.assertEqual(len(transport.captures), 1)
        self.assertEqual(transport.outcomes, [])



if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Explicitly owner-admitted disposable PostgreSQL billing fixture"
    )
    parser.add_argument("--target-receipt", required=True)
    args = parser.parse_args()
    TARGET_RECEIPT = args.target_receipt
    unittest.main(argv=[sys.argv[0]], verbosity=2)
