import asyncio
from concurrent.futures import ThreadPoolExecutor
from dataclasses import replace
import hashlib
import inspect
from pathlib import Path
import os
import subprocess
import tempfile
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, MagicMock, patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src import availability_import
from src import availability_import_store


STORAGE_KEY = "11111111-1111-1111-1111-111111111111.pdf"
TARGET_IDENTITY_HASH = hashlib.sha256(b"staff-1").hexdigest()
PUBLIC_IDENTITY_HASH = hashlib.sha256(b"invitee@example.com").hexdigest()
ACCOUNT_IDENTITY_HASH = hashlib.sha256(b"user-1").hexdigest()


class FakeConnection:
    def __init__(self, cursor):
        self.cursor_obj = cursor
        self.transaction_lock = getattr(getattr(cursor, "state", None), "transaction_lock", None)

    def __enter__(self):
        if self.transaction_lock is not None:
            self.transaction_lock.acquire()
        return self

    def __exit__(self, exc_type, exc, traceback):
        if self.transaction_lock is not None:
            self.transaction_lock.release()
        return False

    def cursor(self):
        return self.cursor_obj


class ClaimCursor:
    def __init__(
        self,
        has_refund=False,
        target_active=True,
        status="PENDING",
        execution_token=None,
        envelope_version=3,
        paid_through="2099-01-01T00:00:00Z",
        paid_through_current=True,
        plan_tier="GROWTH",
        configured_balance=4,
        debit_balance_after=4,
        attempts=0,
        lease_active=False,
    ):
        self.has_refund = has_refund
        self.target_active = target_active
        self.status = status
        self.execution_token = execution_token
        self.envelope_version = envelope_version
        self.paid_through = paid_through
        self.paid_through_current = paid_through_current
        self.plan_tier = plan_tier
        self.configured_balance = configured_balance
        self.debit_balance_after = debit_balance_after
        self.attempts = attempts
        self.lease_active = lease_active
        self.calls = []
        self.result = None
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        compact = " ".join(sql.split())
        self.calls.append((compact, params))
        if compact.startswith('SELECT "status", "planTier", "stripeSubscriptionId"'):
            self.result = (
                "ACTIVE",
                self.plan_tier,
                "sub_paid_1",
                self.paid_through,
                self.paid_through_current if self.paid_through is not None else None,
            )
        elif compact.startswith('SELECT "status", "userId"'):
            self.result = (self.status, "user-1")
        elif 'FROM "User"' in compact and "FOR UPDATE" in compact:
            self.result = ("user-1", "staff-1") if self.target_active else None
        elif 'FROM "AvailabilityImportJob" job' in compact:
            self.result = (
                self.status,
                STORAGE_KEY,
                "a" * 64,
                9,
                b"LLAI" + bytes([self.envelope_version]) + b"encrypted-source",
                {"consumedCredits": 1, "newBalance": self.configured_balance},
                self.execution_token,
                self.lease_active,
                PUBLIC_IDENTITY_HASH,
                ACCOUNT_IDENTITY_HASH,
                "user-1",
                True,
                1,
                "tenant-1",
                -1,
                "Availability PDF import (import-1)",
                self.debit_balance_after,
                1 if self.has_refund else 0,
                "tenant-1" if self.has_refund else None,
                1 if self.has_refund else None,
                "Availability PDF import refund (import-1)" if self.has_refund else None,
                5 if self.has_refund else None,
                self.attempts,
            )

    def fetchone(self):
        return self.result

class TerminalState:
    def __init__(
        self,
        *,
        debit_count=1,
        debit_amount=-1,
        configured_amount=1,
        execution_token=None,
        lease_active=False,
    ):
        self.status = "PENDING"
        self.configured_amount = configured_amount
        self.debit_count = debit_count
        self.debit_amount = debit_amount
        self.execution_token = execution_token
        self.lease_active = lease_active
        self.unexpired = True
        self.attempts = 0
        self.refund_count = 0
        self.refund_attempts = 0
        self.wallet_updates = 0
        self.credit_debt = 0
        self.last_settlement = None
        self.transaction_lock = threading.Lock()


class TerminalCursor:
    def __init__(self, state):
        self.state = state
        self.result = None
        self.calls = []
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        compact = " ".join(sql.split())
        self.calls.append((compact, params))
        if compact.startswith('SELECT "status", "planTier", "stripeSubscriptionId"'):
            self.result = ("ACTIVE", "GROWTH", "sub_paid_1", "2099-01-01T00:00:00Z", True)
        elif 'FROM "AvailabilityImportJob" job' in compact:
            self.result = (
                self.state.status,
                STORAGE_KEY,
                "a" * 64,
                9,
                b"LLAI\x02encrypted-source",
                {"consumedCredits": self.state.configured_amount, "newBalance": 4},
                self.state.execution_token,
                self.state.lease_active,
                PUBLIC_IDENTITY_HASH,
                ACCOUNT_IDENTITY_HASH,
                "user-1",
                self.state.unexpired,
                self.state.debit_count,
                "tenant-1" if self.state.debit_count else None,
                self.state.debit_amount if self.state.debit_count else None,
                "Availability PDF import (import-1)" if self.state.debit_count else None,
                4 if self.state.debit_count else None,
                self.state.refund_count,
                "tenant-1" if self.state.refund_count else None,
                -self.state.debit_amount if self.state.refund_count else None,
                "Availability PDF import refund (import-1)" if self.state.refund_count else None,
                5 if self.state.refund_count else None,
                self.state.attempts,
            )
        elif "FROM public.settle_positive_credit_value" in compact:
            self.state.refund_attempts += 1
            if self.state.refund_count:
                self.result = None
            else:
                self.state.refund_count = 1
                self.state.wallet_updates += 1
                repaid_debt = min(self.state.credit_debt, 1)
                spendable_amount = 1 - repaid_debt
                self.state.last_settlement = (
                    1,
                    spendable_amount,
                    repaid_debt,
                    4 + spendable_amount,
                    self.state.credit_debt - repaid_debt,
                    False,
                )
                self.result = self.state.last_settlement
        elif compact.startswith('UPDATE "AvailabilityImportJob"'):
            self.state.status = params[0]

    def fetchone(self):
        return self.result


class LeaseRaceState:
    def __init__(self):
        self.status = "PENDING"
        self.execution_token = None
        self.lease_active = None
        self.refund_attempts = 0
        self.wallet_updates = 0
        self.transaction_lock = threading.Lock()
        self.ledger = {
            "feature-usage-availability-import:import-1": (
                "tenant-1",
                -1,
                "Availability PDF import (import-1)",
                4,
            ),
        }


class LeaseRaceCursor:
    def __init__(self, state):
        self.state = state
        self.result = None
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        compact = " ".join(sql.split())
        self.result = None
        self.rowcount = 1
        debit = self.state.ledger["feature-usage-availability-import:import-1"]
        refund = self.state.ledger.get("feature-refund-availability-import:import-1")
        if compact.startswith('SELECT "status", "planTier", "stripeSubscriptionId"'):
            self.result = ("ACTIVE", "GROWTH", "sub_paid_1", "2099-01-01T00:00:00Z", True)
        elif compact.startswith('SELECT "status", "userId"'):
            self.result = (self.state.status, "user-1")
        elif 'FROM "User"' in compact and "FOR UPDATE" in compact:
            self.result = ("user-1", "staff-1")
        elif 'FROM "AvailabilityImportJob" job' in compact:
            self.result = (
                self.state.status,
                STORAGE_KEY,
                "a" * 64,
                9,
                b"LLAI\x03encrypted-source",
                {"consumedCredits": 1, "newBalance": 4},
                self.state.execution_token,
                self.state.lease_active,
                PUBLIC_IDENTITY_HASH,
                ACCOUNT_IDENTITY_HASH,
                "user-1",
                True,
                1,
                debit[0],
                debit[1],
                debit[2],
                debit[3],
                1 if refund else 0,
                refund[0] if refund else None,
                refund[1] if refund else None,
                refund[2] if refund else None,
                refund[3] if refund else None,
                getattr(self.state, 'attempts', 0),
            )
        elif "FROM public.settle_positive_credit_value" in compact:
            self.state.refund_attempts += 1
            tenant_id, amount, reason, refund_id = params
            if refund_id in self.state.ledger:
                self.result = None
            else:
                self.state.wallet_updates += 1
                self.state.ledger[refund_id] = (tenant_id, amount, reason, 5)
                self.result = (amount, amount, 0, 5, 0, False)
        elif compact.startswith('UPDATE "AvailabilityImportJob"'):
            if 'SET "status" = \'RUNNING\'' in compact:
                self.state.status = "RUNNING"
                self.state.execution_token = params[1]
                self.state.lease_active = True
            elif 'SET "status" = \'SUCCEEDED\'' in compact:
                if self.state.status == "RUNNING" and self.state.execution_token == params[-1]:
                    self.state.status = "SUCCEEDED"
                    self.state.execution_token = None
                    self.state.lease_active = None
                else:
                    self.rowcount = 0
            else:
                token = params[-2]
                owns_execution = (
                    self.state.execution_token is None or self.state.lease_active is False
                    if token is None
                    else self.state.execution_token == token
                )
                if owns_execution:
                    self.state.status = params[0]
                    self.state.execution_token = None
                    self.state.lease_active = None
                else:
                    self.rowcount = 0

    def fetchone(self):
        return self.result


class RetryHandoffRaceState:
    def __init__(self):
        self.status = "PENDING"
        self.execution_token = None
        self.lease_active = None
        self.lock = threading.Lock()
        self.retry_prechecked = threading.Event()
        self.resume_retry = threading.Event()
        self.pause_retry_precheck = True


class RetryHandoffRaceCursor:
    def __init__(self, state):
        self.state = state
        self.result = None
        self.rowcount = 1

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        compact = " ".join(sql.split())
        self.result = None
        self.rowcount = 1
        if compact.startswith('SELECT "status", "planTier", "stripeSubscriptionId"'):
            self.result = ("ACTIVE", "GROWTH", "sub_paid_1", "2099-01-01T00:00:00Z", True)
        elif compact.startswith('SELECT "status", "userId"'):
            with self.state.lock:
                self.result = (self.state.status, "user-1")
        elif 'FROM "User"' in compact and "FOR UPDATE" in compact:
            self.result = ("user-1", "staff-1")
        elif compact.startswith('SELECT "status", "executionToken"'):
            with self.state.lock:
                self.result = (
                    self.state.status,
                    self.state.execution_token,
                    self.state.lease_active,
                )
            self.state.retry_prechecked.set()
            if self.state.pause_retry_precheck and not self.state.resume_retry.wait(timeout=2):
                raise RuntimeError("retry handoff barrier timed out")
        elif 'FROM "AvailabilityImportJob" job' in compact:
            with self.state.lock:
                self.result = (
                    self.state.status,
                    STORAGE_KEY,
                    "a" * 64,
                    9,
                    b"LLAI\x03encrypted-source",
                    {"consumedCredits": 1, "newBalance": 4},
                    self.state.execution_token,
                    self.state.lease_active,
                    PUBLIC_IDENTITY_HASH,
                    ACCOUNT_IDENTITY_HASH,
                    "user-1",
                    True,
                    1,
                    "tenant-1",
                    -1,
                    "Availability PDF import (import-1)",
                    4,
                    0,
                    None,
                    None,
                    None,
                    None,
                    getattr(self.state, 'attempts', 0),
                )
        elif compact.startswith('UPDATE "AvailabilityImportJob"'):
            with self.state.lock:
                if 'SET "status" = \'RUNNING\'' in compact:
                    self.state.status = "RUNNING"
                    self.state.execution_token = params[1]
                    self.state.lease_active = True
                elif 'SET "status" = \'RETRYING\'' in compact:
                    token = params[-2]
                    owns_execution = (
                        self.state.execution_token is None or self.state.lease_active is False
                        if token is None
                        else self.state.execution_token == token
                    )
                    if owns_execution:
                        self.state.status = "RETRYING"
                        self.state.execution_token = None
                        self.state.lease_active = None
                    else:
                        self.rowcount = 0

    def fetchone(self):
        return self.result


class RetentionCursor:
    def __init__(self, rows):
        self.rows = rows
        self.calls = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        self.calls.append((" ".join(sql.split()), params))

    def fetchall(self):
        return self.rows


class AvailabilityImportStoreTests(unittest.TestCase):
    def setUp(self):
        self.saved_retention_cursor = availability_import_store._RETENTION_SWEEP_CURSOR
        availability_import_store._RETENTION_SWEEP_CURSOR = None

    def tearDown(self):
        availability_import_store._RETENTION_SWEEP_CURSOR = self.saved_retention_cursor

    def test_republished_orphan_preserves_debit_and_rejects_the_revoked_worker(self):
        # Publisher recovery leaves the original source/reservation and revokes
        # the crashed worker's token before returning the job to PENDING.
        state = LeaseRaceState()
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        original_ledger = dict(state.ledger)
        with patch.object(
            availability_import_store,
            "_connect",
            side_effect=lambda: FakeConnection(LeaseRaceCursor(state)),
        ):
            for action in (
                lambda: availability_import_store.complete_import(payload, "crashed-worker", PUBLIC_IDENTITY_HASH, []),
                lambda: availability_import_store.terminalize_import(payload, "crashed-worker", "FAILED", "TRANSIENT_FAILURE"),
            ):
                with self.assertRaisesRegex(availability_import_store.AvailabilityImportRejected, "ownership changed"):
                    action()
            replacement = availability_import_store.claim_import(payload, 0, "replacement-worker")
            self.assertEqual(replacement.execution_token, "replacement-worker")
            self.assertIsNotNone(replacement.encrypted_source_payload)
            with self.assertRaises(availability_import_store.AvailabilityImportBusy):
                availability_import_store.claim_import(payload, 0, "duplicate-delivery")
            with self.assertRaisesRegex(availability_import_store.AvailabilityImportRejected, "ownership changed"):
                availability_import_store.complete_import(payload, "crashed-worker", PUBLIC_IDENTITY_HASH, [])
            availability_import_store.complete_import(payload, "replacement-worker", PUBLIC_IDENTITY_HASH, [])

        self.assertEqual(state.status, "SUCCEEDED")
        self.assertEqual(state.ledger, original_ledger)
        self.assertEqual(state.refund_attempts, 0)
        self.assertEqual(state.wallet_updates, 0)

    def test_claim_rejects_a_refunded_late_delivery_without_overwriting_terminal_ownership(self):
        cursor = ClaimCursor(has_refund=True)
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ):
            with self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "paid credit reservation",
            ):
                availability_import_store.claim_import(payload, 0, "execution-token")

        sql_text = "\n".join(sql for sql, _ in cursor.calls)
        self.assertIn("'feature-refund-availability-import:'", sql_text)
        self.assertIn('"expiresAt" > CURRENT_TIMESTAMP', sql_text)
        self.assertIn('"deletedAt" IS NULL', sql_text)
        self.assertIn('"suspendedAt" IS NULL', sql_text)
        self.assertIn('job."targetIdentityHash"', sql_text)
        self.assertIn('job."requestHash"', sql_text)
        self.assertNotIn('UPDATE "AvailabilityImportJob"', sql_text)

    def test_claim_sets_running_only_after_subscription_debit_and_no_refund_are_proven(self):
        cursor = ClaimCursor(has_refund=False)
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ):
            claimed = availability_import_store.claim_import(payload, 2, "execution-token")

        self.assertEqual(claimed.status, "claimed")
        update_sql, update_params = next(
            (sql, params)
            for sql, params in cursor.calls
            if sql.startswith('UPDATE "AvailabilityImportJob"')
        )
        self.assertIn('"status" = \'RUNNING\'', update_sql)
        self.assertEqual(claimed.encrypted_source_payload, b"LLAI\x03encrypted-source")
        self.assertEqual(claimed.request_identity_hash, PUBLIC_IDENTITY_HASH)
        self.assertEqual(claimed.target_identity_hash, ACCOUNT_IDENTITY_HASH)
        self.assertIsNotNone(claimed.path)
        self.assertEqual(update_params[:2], (3, "execution-token"))

    def test_lowered_broker_retry_count_cannot_reset_durable_attempts(self):
        cursor = ClaimCursor(attempts=2)
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        with patch.object(availability_import_store, "_connect", return_value=FakeConnection(cursor)):
            claimed = availability_import_store.claim_import(payload, 0, "new-owner")
        self.assertEqual(claimed.effective_retry_count, 2)
        update = next(params for sql, params in cursor.calls if sql.startswith('UPDATE "AvailabilityImportJob"'))
        self.assertEqual(update[0], 3)

    def test_durable_retry_budget_rejects_exhausted_recovery_before_another_execution(self):
        cursor = ClaimCursor(attempts=4)
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        with patch.dict(os.environ, {"WORKER_MAX_RETRIES": "3"}), patch.object(
            availability_import_store, "_connect", return_value=FakeConnection(cursor)
        ), self.assertRaisesRegex(availability_import_store.AvailabilityImportRejected, "durable retry budget"):
            availability_import_store.claim_import(payload, 0, "new-owner")
        self.assertFalse(any(sql.startswith('UPDATE "AvailabilityImportJob"') for sql, _ in cursor.calls))

    def test_exhausted_duplicate_never_overrides_a_live_owner(self):
        cursor = ClaimCursor(status="RUNNING", execution_token="live-owner", lease_active=True, attempts=4)
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        with patch.object(availability_import_store, "_connect", return_value=FakeConnection(cursor)), self.assertRaises(
            availability_import_store.AvailabilityImportBusy
        ):
            availability_import_store.claim_import(payload, 0, "duplicate")
        self.assertFalse(any(sql.startswith('UPDATE "AvailabilityImportJob"') for sql, _ in cursor.calls))

    def test_claim_fails_closed_for_missing_or_expired_authoritative_paid_through_even_with_credits(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        cases = (
            (None, None),
            ("2026-07-15T00:00:00Z", False),
        )

        for paid_through, paid_through_current in cases:
            cursor = ClaimCursor(
                paid_through=paid_through,
                paid_through_current=paid_through_current,
            )
            with self.subTest(paid_through=paid_through), patch.object(
                availability_import_store,
                "_connect",
                return_value=FakeConnection(cursor),
            ), self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "active paid subscription",
            ):
                availability_import_store.claim_import(payload, 0, "execution-token")

            self.assertFalse(
                any(sql.startswith('UPDATE "AvailabilityImportJob"') for sql, _ in cursor.calls)
            )

    def test_claim_fails_closed_for_free_plan_even_with_future_paid_through_and_credits(self):
        cursor = ClaimCursor(plan_tier="FREE")
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ), self.assertRaisesRegex(
            availability_import_store.AvailabilityImportRejected,
            "active paid subscription",
        ):
            availability_import_store.claim_import(payload, 0, "execution-token")

        self.assertIn('"planTier"', cursor.calls[1][0])
        self.assertFalse(
            any(sql.startswith('UPDATE "AvailabilityImportJob"') for sql, _ in cursor.calls)
        )

    def test_claim_rejects_missing_or_mismatched_immutable_debit_balance(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        for debit_balance_after in (None, 3):
            cursor = ClaimCursor(debit_balance_after=debit_balance_after)
            with self.subTest(debit_balance_after=debit_balance_after), patch.object(
                availability_import_store,
                "_connect",
                return_value=FakeConnection(cursor),
            ), self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "paid credit reservation",
            ):
                availability_import_store.claim_import(payload, 0, "execution-token")

    def test_completion_rechecks_authoritative_paid_through_before_commit(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        for paid_through, paid_through_current in (
            (None, None),
            ("2026-07-15T00:00:00Z", False),
        ):
            cursor = ClaimCursor(
                status="RUNNING",
                execution_token="execution-token",
                paid_through=paid_through,
                paid_through_current=paid_through_current,
            )
            with self.subTest(paid_through=paid_through), patch.object(
                availability_import_store,
                "_connect",
                return_value=FakeConnection(cursor),
            ), self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "active paid subscription",
            ):
                availability_import_store.complete_import(
                    payload,
                    "execution-token",
                    PUBLIC_IDENTITY_HASH,
                    [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
                )

            self.assertFalse(
                any(
                    sql.startswith('UPDATE "AvailabilityImportJob"') and "SUCCEEDED" in sql
                    for sql, _ in cursor.calls
                )
            )

    def test_completion_blocks_paid_to_free_transition_after_claim(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        claim_cursor = ClaimCursor()
        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(claim_cursor),
        ):
            claimed = availability_import_store.claim_import(payload, 0, "execution-token")
        self.assertEqual(claimed.status, "claimed")

        completion_cursor = ClaimCursor(
            status="RUNNING",
            execution_token="execution-token",
            plan_tier="FREE",
        )
        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(completion_cursor),
        ), self.assertRaisesRegex(
            availability_import_store.AvailabilityImportRejected,
            "active paid subscription",
        ):
            availability_import_store.complete_import(
                payload,
                "execution-token",
                PUBLIC_IDENTITY_HASH,
                [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
            )

        self.assertFalse(
            any(
                sql.startswith('UPDATE "AvailabilityImportJob"') and "SUCCEEDED" in sql
                for sql, _ in completion_cursor.calls
            )
        )

    def test_completion_revalidates_target_identity_under_the_user_then_job_locks(self):
        cursor = ClaimCursor(status="RUNNING", execution_token="execution-token")
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ):
            availability_import_store.complete_import(
                payload,
                "execution-token",
                PUBLIC_IDENTITY_HASH,
                [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
            )

        sql_text = [sql for sql, _ in cursor.calls]
        target_lock = next(index for index, sql in enumerate(sql_text) if 'FROM "User"' in sql)
        job_lock = next(index for index, sql in enumerate(sql_text) if 'FROM "AvailabilityImportJob" job' in sql)
        completion = next(sql for sql in sql_text if sql.startswith('UPDATE "AvailabilityImportJob"'))
        self.assertLess(target_lock, job_lock)
        self.assertIn('"status" = \'SUCCEEDED\'', completion)
        self.assertIn('"storageKey" = NULL', completion)
        self.assertIn('"encryptedSourcePayload" = NULL', completion)
        self.assertIn('"executionToken" = %s', completion)

    def test_completion_rejects_a_document_identifier_that_only_matches_the_internal_account(self):
        cursor = ClaimCursor(status="RUNNING", execution_token="execution-token")
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ):
            with self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "target identity did not match",
            ):
                availability_import_store.complete_import(
                    payload,
                    "execution-token",
                    ACCOUNT_IDENTITY_HASH,
                    [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
                )

    def test_legacy_versions_use_one_fail_closed_account_identity_policy(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        for envelope_version in (1, 2):
            with self.subTest(envelope_version=envelope_version):
                cursor = ClaimCursor(
                    status="RUNNING",
                    execution_token="execution-token",
                    envelope_version=envelope_version,
                )
                with patch.object(
                    availability_import_store,
                    "_connect",
                    return_value=FakeConnection(cursor),
                ):
                    availability_import_store.complete_import(
                        payload,
                        "execution-token",
                        ACCOUNT_IDENTITY_HASH,
                        [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
                    )

                completion = next(
                    sql for sql, _ in cursor.calls
                    if sql.startswith('UPDATE "AvailabilityImportJob"')
                )
                self.assertIn('"status" = \'SUCCEEDED\'', completion)

    def test_completion_rejects_a_deleted_target_before_the_final_write(self):
        cursor = ClaimCursor(
            target_active=False,
            status="RUNNING",
            execution_token="execution-token",
        )
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ):
            with self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "target is not active",
            ):
                availability_import_store.complete_import(
                    payload,
                    "execution-token",
                    TARGET_IDENTITY_HASH,
                    [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
                )

        target_lock = next(sql for sql, _ in cursor.calls if 'FROM "User"' in sql)
        self.assertIn('"role" IN (\'MANAGER\', \'STAFF\')', target_lock)
        self.assertIn('"suspendedAt" IS NULL', target_lock)
        self.assertFalse(
            any(sql.startswith('UPDATE "AvailabilityImportJob"') for sql, _ in cursor.calls)
        )

    def test_retention_is_completion_based_and_erases_terminal_payloads_after_24_hours(self):
        source = inspect.getsource(availability_import_store._select_retention_batch)

        self.assertIn('"completedAt" <= CURRENT_TIMESTAMP - INTERVAL \'24 hours\'', source)
        self.assertIn("'CANCELLED'", source)

    def test_malformed_oldest_retention_row_does_not_starve_later_rows(self):
        rows = [
            ("import-1", "tenant-1", STORAGE_KEY, "PENDING", True, 0),
            ("import-2", "tenant-2", None, "SUCCEEDED", True, 1),
        ]
        cursor = RetentionCursor(rows)
        visited = []

        def sweep_row(payload, storage_key, status, expired):
            visited.append((payload.import_id, storage_key, status))
            if payload.import_id == "import-1":
                raise availability_import_store.AvailabilityImportRejected("malformed settlement")

        with patch.dict(
            os.environ,
            {"PLATFORM_ADMIN_DB_CONTEXT_SECRET": "test-capability"},
        ), patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(cursor),
        ), patch.object(
            availability_import_store,
            "_sweep_expired_import",
            side_effect=sweep_row,
        ), self.assertRaisesRegex(
            availability_import_store.AvailabilityImportRetentionSweepFailed,
            "1 availability import retention row",
        ):
            availability_import_store.sweep_expired_imports()

        self.assertEqual(
            visited,
            [
                ("import-1", STORAGE_KEY, "PENDING"),
                ("import-2", None, "SUCCEEDED"),
            ],
        )
        selection = cursor.calls[1][0]
        self.assertIn('ORDER BY "retentionPriority", "id"', selection)
        self.assertIn("FOR UPDATE SKIP LOCKED", selection)

    def test_full_poison_batch_rotates_to_later_sources_and_wraps_to_retry_failures(self):
        rows = [(f"import-{index}", "tenant-1", f"{index:08d}-1111-1111-1111-111111111111.pdf", "RUNNING", True, 0)
                for index in range(1, 5)]
        eligible = {row[0]: row for row in rows}
        selected_after = []
        visited = []
        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def execute(self, sql, params=None):
                if 'FROM "AvailabilityImportJob"' in sql:
                    priority, _, last_id, limit = params
                    after = (priority, last_id) if priority is not None else None
                    selected_after.append(after)
                    ordered = sorted(eligible.values(), key=lambda row: (row[5], row[0]))
                    self.result = [row for row in ordered if after is None or (row[5], row[0]) > after][:limit]
            def fetchall(self): return self.result
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {
            "WORKER_UPLOAD_ROOT": root, "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "capability",
            "WORKER_AVAILABILITY_RETENTION_BATCH_SIZE": "2",
        }), patch.object(availability_import_store, "_connect", side_effect=lambda: FakeConnection(Cursor())):
            for row in rows: (Path(root) / row[2]).write_bytes(b"retained source")
            def hard_erase(payload):
                visited.append(payload.import_id)
                if payload.import_id in {"import-1", "import-2"}: raise OSError("persistent unlink failure")
                row = eligible.pop(payload.import_id)
                (Path(root) / row[2]).unlink()
                return True
            with patch.object(availability_import_store, "_erase_hard_expired_import_source", side_effect=hard_erase), patch.object(
                availability_import_store, "terminalize_import"
            ), patch.object(availability_import_store, "_erase_retained_import_source"):
                with self.assertRaises(availability_import_store.AvailabilityImportRetentionSweepFailed):
                    availability_import_store.sweep_expired_imports()
                # Each eligible row is acted on only once by the age-first path.
                with patch.object(availability_import_store, "_sweep_expired_import", side_effect=lambda payload, *_:
                                  hard_erase(payload)):
                    self.assertEqual(availability_import_store.sweep_expired_imports(), 2)
                    with self.assertRaises(availability_import_store.AvailabilityImportRetentionSweepFailed):
                        availability_import_store.sweep_expired_imports()
            self.assertTrue(all((Path(root) / row[2]).exists() for row in rows[:2]))
            self.assertTrue(all(not (Path(root) / row[2]).exists() for row in rows[2:]))
            self.assertEqual(visited, ["import-1", "import-2", "import-3", "import-4", "import-1", "import-2"])
            self.assertEqual(selected_after, [None, (0, "import-2"), (0, "import-4"), None])
            before = availability_import_store._RETENTION_SWEEP_CURSOR
            with patch.object(availability_import_store, "_select_retention_batch", side_effect=RuntimeError("selection failed")):
                with self.assertRaisesRegex(RuntimeError, "selection failed"):
                    availability_import_store.sweep_expired_imports()
            self.assertEqual(availability_import_store._RETENTION_SWEEP_CURSOR, before)
            eligible.clear()
            self.assertEqual(availability_import_store.sweep_expired_imports(), 0)
            self.assertIsNone(availability_import_store._RETENTION_SWEEP_CURSOR)

    def test_retention_preserves_an_expired_source_when_terminal_settlement_fails(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        with patch.object(
            availability_import_store,
            "terminalize_import",
            side_effect=availability_import_store.AvailabilityImportRejected(
                "debit provenance check failed",
            ),
        ), patch.object(
            availability_import_store,
            "_erase_retained_import_source",
        ) as erase, patch.object(availability_import_store, "_erase_hard_expired_import_source") as hard_erase:
            with self.assertRaises(availability_import_store.AvailabilityImportRejected):
                availability_import_store._sweep_expired_import(
                    payload,
                    STORAGE_KEY,
                    "PENDING",
                )

        erase.assert_not_called()
        self.assertEqual(hard_erase.call_count, 2)

    def test_hard_source_erasure_needs_a_committed_age_match_and_current_key(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        for row in (None, (None,), (STORAGE_KEY,)):
            cursor = MagicMock()
            cursor.rowcount = 1
            cursor.__enter__.return_value = cursor
            cursor.fetchone.return_value = row
            committed = []
            class CommittedConnection(FakeConnection):
                def __exit__(self, *args):
                    committed.append(True)
                    return super().__exit__(*args)
            current_path = MagicMock()
            def resolve(key):
                self.assertEqual(committed, [True])
                self.assertEqual(key, STORAGE_KEY)
                return current_path
            with patch.object(availability_import_store, "_connect", return_value=CommittedConnection(cursor)), patch.object(
                availability_import_store, "resolve_storage_key", side_effect=resolve
            ) as resolve_key:
                availability_import_store._erase_hard_expired_import_source(payload)
            if row == (STORAGE_KEY,):
                current_path.unlink.assert_called_once_with(missing_ok=True)
            else:
                resolve_key.assert_not_called()
            sql, params = cursor.execute.call_args_list[1].args
            self.assertIn('"createdAt" <= CURRENT_TIMESTAMP - INTERVAL \'24 hours\'', sql)
            self.assertIn('FOR UPDATE', sql)
            self.assertEqual(params, ("import-1", "tenant-1", "tenant-1"))
            mutation = sql.split('SET ')[1].split('FROM expired_source')[0]
            self.assertEqual(' '.join(mutation.split()), '"encryptedSourcePayload" = NULL')
            if row == (STORAGE_KEY,):
                final_sql, final_params = cursor.execute.call_args.args
                self.assertIn('AND "storageKey" = %s', final_sql)
                self.assertEqual(final_params, ("import-1", "tenant-1", STORAGE_KEY))

    def test_hard_source_erasure_never_unlinks_if_database_commit_fails(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        cursor = MagicMock()
        cursor.rowcount = 1
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = (STORAGE_KEY,)
        class FailedCommit(FakeConnection):
            def __exit__(self, *args):
                raise RuntimeError("commit failed")
        with patch.object(availability_import_store, "_connect", return_value=FailedCommit(cursor)), patch.object(
            availability_import_store, "resolve_storage_key"
        ) as resolve, self.assertRaisesRegex(RuntimeError, "commit failed"):
            availability_import_store._erase_hard_expired_import_source(payload)
        resolve.assert_not_called()

    def test_hard_source_unlink_or_final_database_failure_keeps_a_retry_pointer(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        for failure_kind in ("unlink", "database"):
            state = SimpleNamespace(key=STORAGE_KEY, envelope=b"encrypted source", fail_clear=failure_kind == "database",
                                    status="RUNNING", owner="old-owner", debit=-1, refunds=0)
            class Cursor:
                def __enter__(self): return self
                def __exit__(self, *args): return False
                def execute(self, sql, params=None):
                    if 'WITH expired_source' in sql:
                        self.result = (state.key,) if state.key is not None or state.envelope is not None else None
                        state.envelope = None
                    elif 'SET "storageKey" = NULL' in sql:
                        if state.fail_clear: raise RuntimeError("final clear failed")
                        self.rowcount = 1 if state.key == params[2] else 0
                        if self.rowcount: state.key = None
                def fetchone(self): return self.result
            def settle(*args):
                state.status = "FAILED"
                state.owner = None
                state.refunds += 1
            with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"WORKER_UPLOAD_ROOT": root}), patch.object(
                availability_import_store, "_connect", side_effect=lambda: FakeConnection(Cursor())
            ), patch.object(availability_import_store, "terminalize_import", side_effect=settle) as terminalize, patch.object(
                availability_import_store, "_erase_retained_import_source"
            ):
                path = Path(root) / STORAGE_KEY
                path.write_bytes(b"local source")
                if failure_kind == "unlink":
                    with patch.object(Path, "unlink", side_effect=OSError("unlink failed")), self.assertRaisesRegex(OSError, "unlink failed"):
                        availability_import_store._sweep_expired_import(payload, None, "RUNNING", True)
                    self.assertTrue(path.exists())
                else:
                    with self.assertRaisesRegex(RuntimeError, "final clear failed"):
                        availability_import_store._sweep_expired_import(payload, None, "RUNNING", True)
                    self.assertFalse(path.exists())
                self.assertEqual(state.key, STORAGE_KEY)
                self.assertIsNone(state.envelope)
                terminalize.assert_not_called()
                self.assertEqual((state.status, state.owner, state.debit, state.refunds), ("RUNNING", "old-owner", -1, 0))
                # A retained key remains a source-bearing sweep candidate even
                # when its encrypted body or its file has already disappeared.
                state.fail_clear = False
                availability_import_store._sweep_expired_import(payload, None, "RUNNING", True)
                self.assertFalse(path.exists())
                self.assertIsNone(state.key)
                self.assertEqual((state.status, state.owner, state.debit, state.refunds), ("FAILED", None, -1, 1))

    def test_hard_source_final_compare_and_set_preserves_a_changed_current_key(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        replacement = "22222222-2222-2222-2222-222222222222.pdf"
        state = SimpleNamespace(key=STORAGE_KEY)
        class Cursor:
            def __enter__(self): return self
            def __exit__(self, *args): return False
            def execute(self, sql, params=None):
                if 'WITH expired_source' in sql: self.result = (state.key,)
                elif 'SET "storageKey" = NULL' in sql:
                    self.rowcount = 1 if state.key == params[2] else 0
                    if self.rowcount: state.key = None
            def fetchone(self): return self.result
        original_unlink = Path.unlink
        def replace_after_unlink(path, **options):
            original_unlink(path, **options)
            state.key = replacement
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"WORKER_UPLOAD_ROOT": root}), patch.object(
            availability_import_store, "_connect", side_effect=lambda: FakeConnection(Cursor())
        ):
            (Path(root) / STORAGE_KEY).write_bytes(b"old source")
            other = Path(root) / replacement
            other.write_bytes(b"new current source")
            with patch.object(Path, "unlink", replace_after_unlink), self.assertRaises(availability_import_store.AvailabilityImportBusy):
                availability_import_store._erase_hard_expired_import_source(payload)
            self.assertEqual(state.key, replacement)
            self.assertEqual(other.read_bytes(), b"new current source")

    def test_hard_source_only_candidate_never_changes_job_expiration_or_uses_stale_path(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        with patch.object(availability_import_store, "_erase_hard_expired_import_source") as hard, patch.object(
            availability_import_store, "terminalize_import"
        ) as settle, patch.object(availability_import_store, "_erase_retained_import_source") as ordinary:
            availability_import_store._sweep_expired_import(payload, "stale-key.pdf", "RUNNING", False)
        hard.assert_called_once_with(payload)
        settle.assert_not_called()
        ordinary.assert_not_called()

    def test_hard_source_erasure_deletes_current_file_and_preserves_stale_local_replica(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        stale_key = "22222222-2222-2222-2222-222222222222.pdf"
        cursor = MagicMock()
        cursor.rowcount = 1
        cursor.__enter__.return_value = cursor
        cursor.fetchone.return_value = (STORAGE_KEY,)
        with tempfile.TemporaryDirectory() as root, patch.dict(os.environ, {"WORKER_UPLOAD_ROOT": root}), patch.object(
            availability_import_store, "_connect", return_value=FakeConnection(cursor)
        ):
            current = Path(root) / STORAGE_KEY
            stale = Path(root) / stale_key
            current.write_bytes(b"current encrypted source")
            stale.write_bytes(b"unrelated local replica")
            availability_import_store._sweep_expired_import(payload, stale_key, "RUNNING", False)
            self.assertFalse(current.exists())
            self.assertEqual(stale.read_bytes(), b"unrelated local replica")

    def test_retention_keeps_both_settlement_and_hard_erasure_failures_observable(self):
        primary = RuntimeError("settlement unavailable")
        cleanup = OSError("hard erasure unavailable")
        with patch.object(availability_import_store, "terminalize_import", side_effect=primary), patch.object(
            availability_import_store, "_erase_hard_expired_import_source", side_effect=[False, cleanup]
        ), self.assertRaises(ExceptionGroup) as caught:
            availability_import_store._sweep_expired_import(availability_import_store.ImportPayload("import-1", "tenant-1"), None, "RUNNING")
        self.assertEqual(caught.exception.exceptions, (primary, cleanup))

    def test_retention_source_erasure_never_changes_status_or_billing_rows(self):
        source = inspect.getsource(availability_import_store._erase_retained_import_source)

        self.assertIn('"encryptedSourcePayload" = NULL', source)
        self.assertIn('THEN COALESCE("resultErasedAt", CURRENT_TIMESTAMP)', source)
        self.assertNotIn('UPDATE "Tenant"', source)
        self.assertNotIn('INSERT INTO "CreditTransaction"', source)
        self.assertNotIn('SET "status"', source)

    def test_terminalization_refunds_the_wallet_once_and_is_idempotent(self):
        state = TerminalState()
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            side_effect=lambda: FakeConnection(TerminalCursor(state)),
        ):
            first_path = availability_import_store.terminalize_import(
                payload,
                None,
                "FAILED",
                "EXPIRED",
            )
            second_path = availability_import_store.terminalize_import(
                payload,
                None,
                "FAILED",
                "EXPIRED",
            )

        self.assertEqual(first_path.name, STORAGE_KEY)
        self.assertIsNone(second_path)
        self.assertEqual(state.refund_attempts, 1)
        terminal_sql = inspect.getsource(availability_import_store.terminalize_import)
        self.assertIn('"encryptedSourcePayload" = NULL', terminal_sql)
        self.assertIn('WHEN %s::text IS NULL THEN', terminal_sql)
        self.assertIn('"executionLeaseUntil" <= CURRENT_TIMESTAMP', terminal_sql)
        self.assertIn('ELSE "executionToken" = %s', terminal_sql)
        self.assertIn('credit."debtAfter" = 0', inspect.getsource(availability_import_store._lock_job))
        self.assertEqual(state.wallet_updates, 1)

    def test_terminalization_repays_credit_debt_before_restoring_wallet_value(self):
        state = TerminalState()
        state.credit_debt = 1
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(TerminalCursor(state)),
        ):
            availability_import_store.terminalize_import(
                payload,
                None,
                "FAILED",
                "EXPIRED",
            )

        self.assertEqual(state.last_settlement, (1, 0, 1, 4, 0, False))
        self.assertEqual(state.wallet_updates, 1)

    def test_tokenless_terminalization_requires_a_proven_expired_foreign_lease(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        for lease_active in (True, None):
            state = TerminalState(execution_token="foreign-worker", lease_active=lease_active)
            with self.subTest(lease_active=lease_active), patch.object(
                availability_import_store,
                "_connect",
                return_value=FakeConnection(TerminalCursor(state)),
            ), self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "execution ownership changed",
            ):
                availability_import_store.terminalize_import(
                    payload,
                    None,
                    "FAILED",
                    "CLAIM_REJECTED",
                )
            self.assertEqual(state.refund_attempts, 0)
            self.assertEqual(state.wallet_updates, 0)

        expired = TerminalState(execution_token="foreign-worker", lease_active=False)
        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(TerminalCursor(expired)),
        ):
            availability_import_store.terminalize_import(
                payload,
                None,
                "FAILED",
                "CLAIM_REJECTED",
            )
        self.assertEqual(expired.status, "FAILED")
        self.assertEqual(expired.refund_attempts, 1)
        self.assertEqual(expired.wallet_updates, 1)

    def test_expired_null_lease_foreign_token_settles_once_but_live_lease_stays_fenced(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        for lease_active in (None, True):
            state = TerminalState(execution_token="old-owner", lease_active=lease_active)
            state.status = "RUNNING"
            state.unexpired = False
            with patch.object(availability_import_store, "_connect", side_effect=lambda: FakeConnection(TerminalCursor(state))):
                if lease_active is True:
                    with self.assertRaises(availability_import_store.AvailabilityImportRejected):
                        availability_import_store.terminalize_import(payload, None, "FAILED", "EXPIRED")
                    self.assertEqual(state.refund_attempts, 0)
                else:
                    availability_import_store.terminalize_import(payload, None, "FAILED", "EXPIRED")
                    availability_import_store.terminalize_import(payload, None, "FAILED", "EXPIRED")
                    self.assertEqual(state.refund_attempts, 1)
                    self.assertEqual(state.status, "FAILED")

    def test_concurrent_terminalization_refunds_and_increments_the_wallet_once(self):
        state = TerminalState()
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        def terminalize():
            return availability_import_store.terminalize_import(
                payload,
                None,
                "FAILED",
                "EXPIRED",
            )

        with patch.object(
            availability_import_store,
            "_connect",
            side_effect=lambda: FakeConnection(TerminalCursor(state)),
        ), ThreadPoolExecutor(max_workers=2) as pool:
            results = list(pool.map(lambda _: terminalize(), range(2)))

        self.assertEqual(sum(path is not None for path in results), 1)
        self.assertEqual(state.refund_attempts, 1)
        self.assertEqual(state.refund_count, 1)
        self.assertEqual(state.wallet_updates, 1)

    def test_terminalization_fails_closed_for_missing_mismatched_or_duplicate_debits(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        states = (
            TerminalState(debit_count=0, debit_amount=None),
            TerminalState(debit_amount=-2),
            TerminalState(debit_count=2),
        )

        for state in states:
            with self.subTest(state=state), patch.object(
                availability_import_store,
                "_connect",
                return_value=FakeConnection(TerminalCursor(state)),
            ), self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "debit provenance",
            ):
                availability_import_store.terminalize_import(
                    payload,
                    None,
                    "FAILED",
                    "EXPIRED",
                )
            self.assertEqual(state.status, "PENDING")
            self.assertEqual(state.refund_attempts, 0)
            self.assertEqual(state.wallet_updates, 0)

    def test_paused_tokenless_retry_handoff_cannot_clear_a_new_live_claim(self):
        state = RetryHandoffRaceState()
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            side_effect=lambda: FakeConnection(RetryHandoffRaceCursor(state)),
        ), ThreadPoolExecutor(max_workers=2) as pool:
            retry_handoff = pool.submit(
                availability_import_store.mark_retrying,
                payload,
                None,
                1,
            )
            try:
                self.assertTrue(
                    state.retry_prechecked.wait(timeout=2),
                    "tokenless retry handoff did not reach its precheck barrier",
                )
                claimed = availability_import_store.claim_import(payload, 0, "worker-a")
            finally:
                state.resume_retry.set()

            self.assertEqual(claimed.execution_token, "worker-a")
            with self.assertRaisesRegex(
                availability_import_store.AvailabilityImportBusy,
                "retry ownership changed",
            ):
                retry_handoff.result(timeout=2)

        self.assertEqual(state.status, "RUNNING")
        self.assertEqual(state.execution_token, "worker-a")
        self.assertTrue(state.lease_active)

    def test_tokenless_retry_handoff_precheck_rejects_an_existing_live_owner(self):
        state = RetryHandoffRaceState()
        state.status = "RUNNING"
        state.execution_token = "worker-a"
        state.lease_active = True
        state.pause_retry_precheck = False
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")

        with patch.object(
            availability_import_store,
            "_connect",
            return_value=FakeConnection(RetryHandoffRaceCursor(state)),
        ), self.assertRaisesRegex(
            availability_import_store.AvailabilityImportBusy,
            "active execution owner",
        ):
            availability_import_store.mark_retrying(payload, None, 1)

        self.assertEqual(state.status, "RUNNING")
        self.assertEqual(state.execution_token, "worker-a")
        self.assertTrue(state.lease_active)


def encrypted_claim(source, path=None, key=b"z" * 32):
    payload = availability_import_store.ImportPayload("import-1", "tenant-1")
    digest = hashlib.sha256(source).hexdigest()
    unsigned = availability_import_store.ClaimedImport(
        payload,
        "execution-token",
        path,
        digest,
        len(source),
        "claimed",
        None,
        PUBLIC_IDENTITY_HASH,
        ACCOUNT_IDENTITY_HASH,
    )
    nonce = b"n" * 12
    encrypted = AESGCM(key).encrypt(nonce, source, availability_import._source_aad(unsigned))
    envelope = b"LLAI" + b"\x03" + nonce + encrypted[-16:] + encrypted[:-16]
    return availability_import_store.ClaimedImport(
        payload,
        "execution-token",
        path,
        digest,
        len(source),
        "claimed",
        envelope,
        PUBLIC_IDENTITY_HASH,
        ACCOUNT_IDENTITY_HASH,
    )


def valid_parser_result():
    return {
        "sourceStaffIdentityHash": TARGET_IDENTITY_HASH,
        "parsedAvailability": [
            {"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}
        ],
    }


class AvailabilityImportOrchestrationTests(unittest.IsolatedAsyncioTestCase):

    async def test_parser_failure_propagates_the_effective_durable_retry_budget(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        claimed = availability_import_store.ClaimedImport(payload, "owner", None, "a" * 64, 9, "claimed", effective_retry_count=2)
        with patch.object(availability_import, "claim_import", return_value=claimed), patch.object(
            availability_import, "_parse_claimed_source", side_effect=RuntimeError("parser unavailable")
        ):
            with self.assertRaises(availability_import_store.AvailabilityImportRetryable) as caught:
                await availability_import.process_availability_import({"import_id": "import-1", "tenant_id": "tenant-1"}, 0)
        self.assertEqual(caught.exception.effective_retry_count, 2)

    async def test_queue_handoff_uses_effective_budget_instead_of_lowered_envelope(self):
        import json
        import main
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        failure = availability_import_store.AvailabilityImportRetryable("parser failed", payload, "owner", 2)
        message = SimpleNamespace(body=json.dumps({"type": "pdf.parse", "job_id": "import-1", "retry_count": 0,
            "payload": {"import_id": "import-1", "tenant_id": "tenant-1"}}).encode(), message_id="import-1",
            ack=AsyncMock(), nack=AsyncMock())
        channel = SimpleNamespace(default_exchange=object())
        with patch.object(main, "process_message", side_effect=failure), patch.object(main, "MAX_RETRIES", 3), patch.object(
            main, "publish_retry", new_callable=AsyncMock
        ) as publish, patch.object(main, "try_mark_schedule_status_from_message", new_callable=AsyncMock) as mark:
            await main.handle_queue_message(channel, message)
        self.assertEqual(publish.call_args.args[2], 3)
        self.assertEqual(mark.call_args.args[3], 3)
        message.ack.assert_awaited_once()

    async def test_queue_exhaustion_uses_effective_budget_without_publishing_another_retry(self):
        import json
        import main
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        failure = availability_import_store.AvailabilityImportRetryable("parser failed", payload, "owner", 3)
        message = SimpleNamespace(body=json.dumps({"type": "pdf.parse", "job_id": "import-1", "retry_count": 0,
            "payload": {"import_id": "import-1", "tenant_id": "tenant-1"}}).encode(), message_id="import-1")
        with patch.object(main, "process_message", side_effect=failure), patch.object(main, "MAX_RETRIES", 3), patch.object(
            main, "publish_retry", new_callable=AsyncMock
        ) as publish, patch.object(main, "try_mark_schedule_status_from_message", new_callable=AsyncMock) as mark, patch.object(
            main, "reject_to_solver_dlq", new_callable=AsyncMock
        ) as reject:
            await main.handle_queue_message(SimpleNamespace(), message)
        publish.assert_not_called()
        self.assertEqual(mark.call_args.args[1], "DEAD_LETTERED")
        reject.assert_awaited_once()

    async def test_dead_letter_settlement_poison_erases_owned_source_without_looping(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        reason = availability_import_store.AvailabilityImportRetryable(
            "parser infrastructure failed",
            payload,
            "execution-token",
        )
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / STORAGE_KEY
            path.write_bytes(b"LLAI\x03encrypted-source")
            with patch.object(
                availability_import,
                "terminalize_import",
                side_effect=availability_import_store.AvailabilityImportRejected(
                    "debit provenance check failed",
                ),
            ) as terminalize, patch.object(
                availability_import,
                "erase_owned_import_source",
                return_value=path,
            ) as erase:
                await availability_import.mark_import_retry(
                    {"import_id": "import-1", "tenant_id": "tenant-1"},
                    "DEAD_LETTERED",
                    3,
                    reason,
                )

            terminalize.assert_called_once_with(
                payload,
                "execution-token",
                "DEAD_LETTERED",
                "PROCESSING_FAILED",
            )
            erase.assert_called_once_with(payload, "execution-token")
            self.assertFalse(path.exists())

    async def test_dead_letter_transient_database_failure_still_requests_redelivery(self):
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        reason = availability_import_store.AvailabilityImportRetryable(
            "parser infrastructure failed",
            payload,
            "execution-token",
        )
        with patch.object(
            availability_import,
            "terminalize_import",
            side_effect=RuntimeError("database unavailable"),
        ), patch.object(
            availability_import,
            "erase_owned_import_source",
        ) as erase:
            with self.assertRaisesRegex(RuntimeError, "database unavailable"):
                await availability_import.mark_import_retry(
                    {"import_id": "import-1", "tenant_id": "tenant-1"},
                    "DEAD_LETTERED",
                    3,
                    reason,
                )

        erase.assert_not_called()

    async def test_retention_loop_sets_ready_only_after_success_and_fails_closed_while_draining(self):
        observed = {}

        async def stop_while_ready(interval):
            observed.update({
                "interval": interval,
                "running": availability_import_store.RETENTION_SWEEP_RUNNING._value.get(),
                "ready": availability_import_store.RETENTION_SWEEP_READY._value.get(),
                "last_success": availability_import_store.RETENTION_SWEEP_LAST_SUCCESS._value.get(),
            })
            raise asyncio.CancelledError()

        availability_import_store.RETENTION_SWEEP_LAST_SUCCESS.set(0)
        with patch.object(
            availability_import_store.asyncio,
            "to_thread",
            new=AsyncMock(return_value=0),
        ), patch.object(
            availability_import_store.asyncio,
            "sleep",
            side_effect=stop_while_ready,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await availability_import_store.run_availability_import_retention_loop()

        self.assertEqual(observed["interval"], 300.0)
        self.assertEqual(observed["running"], 1)
        self.assertEqual(observed["ready"], 1)
        self.assertGreater(observed["last_success"], 0)
        self.assertEqual(availability_import_store.RETENTION_SWEEP_READY._value.get(), 0)
        self.assertEqual(availability_import_store.RETENTION_SWEEP_RUNNING._value.get(), 0)

    async def test_retention_shutdown_marks_draining_before_waiting_for_the_active_sweep(self):
        started = asyncio.Event()
        release = asyncio.Event()

        async def blocked_sweep(_function):
            started.set()
            await release.wait()
            return 0

        with patch.object(
            availability_import_store.asyncio,
            "to_thread",
            side_effect=blocked_sweep,
        ):
            loop = asyncio.create_task(
                availability_import_store.run_availability_import_retention_loop(),
            )
            await started.wait()
            loop.cancel()
            await asyncio.sleep(0)

            self.assertFalse(loop.done())
            self.assertEqual(availability_import_store.RETENTION_SWEEP_READY._value.get(), 0)
            self.assertEqual(availability_import_store.RETENTION_SWEEP_RUNNING._value.get(), 1)

            release.set()
            with self.assertRaises(asyncio.CancelledError):
                await loop

        self.assertEqual(availability_import_store.RETENTION_SWEEP_READY._value.get(), 0)
        self.assertEqual(availability_import_store.RETENTION_SWEEP_RUNNING._value.get(), 0)

    async def test_ambiguous_claim_failure_propagates_only_its_candidate_token(self):
        candidate_token = "b" * 32
        with patch.object(
            availability_import.uuid,
            "uuid4",
            return_value=SimpleNamespace(hex=candidate_token),
        ), patch.object(
            availability_import,
            "claim_import",
            side_effect=RuntimeError("database acknowledgement lost"),
        ):
            with self.assertRaises(availability_import_store.AvailabilityImportRetryable) as raised:
                await availability_import.process_availability_import(
                    {"import_id": "import-1", "tenant_id": "tenant-1"},
                    0,
                )

        self.assertEqual(raised.exception.execution_token, candidate_token)

    async def test_rejected_claim_cannot_refund_a_new_live_execution_owner(self):
        state = LeaseRaceState()
        payload = availability_import_store.ImportPayload("import-1", "tenant-1")
        raw = {"import_id": payload.import_id, "tenant_id": payload.tenant_id}
        stale_terminalization_waiting = threading.Event()
        resume_stale_worker = threading.Barrier(2)

        def reject_stale_claim(*_args):
            raise availability_import_store.AvailabilityImportRejected("stale claim rejected")

        def terminalize_after_barrier(*args):
            stale_terminalization_waiting.set()
            resume_stale_worker.wait(timeout=2)
            return availability_import_store.terminalize_import(*args)

        with patch.object(
            availability_import_store,
            "_connect",
            side_effect=lambda: FakeConnection(LeaseRaceCursor(state)),
        ), patch.object(
            availability_import,
            "claim_import",
            side_effect=reject_stale_claim,
        ), patch.object(
            availability_import,
            "terminalize_import",
            side_effect=terminalize_after_barrier,
        ):
            stale_worker = asyncio.create_task(
                availability_import.process_availability_import(raw, 0)
            )
            self.assertTrue(
                await asyncio.to_thread(stale_terminalization_waiting.wait, 2),
                "stale worker did not reach the post-rejection barrier",
            )

            live_claim = await asyncio.to_thread(
                availability_import_store.claim_import,
                payload,
                0,
                "worker-b",
            )
            self.assertEqual(live_claim.execution_token, "worker-b")
            self.assertEqual(state.status, "RUNNING")
            self.assertTrue(state.lease_active)

            await asyncio.to_thread(resume_stale_worker.wait, 2)
            with self.assertRaises(availability_import_store.AvailabilityImportRetryable):
                await stale_worker

            await asyncio.to_thread(
                availability_import_store.complete_import,
                payload,
                "worker-b",
                PUBLIC_IDENTITY_HASH,
                [{"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}],
            )

        self.assertEqual(state.status, "SUCCEEDED")
        self.assertEqual(state.refund_attempts, 0)
        self.assertEqual(state.wallet_updates, 0)
        self.assertEqual(
            state.ledger,
            {
                "feature-usage-availability-import:import-1": (
                    "tenant-1",
                    -1,
                    "Availability PDF import (import-1)",
                    4,
                ),
            },
        )

    async def test_terminal_redelivery_skips_parser_and_persistence(self):
        payload = {"import_id": "import-1", "tenant_id": "tenant-1"}
        claimed = availability_import_store.ClaimedImport(
            availability_import_store.ImportPayload("import-1", "tenant-1"),
            "execution-token",
            Path(),
            "",
            0,
            "terminal",
        )
        parser = MagicMock()

        with patch.object(availability_import, "claim_import", return_value=claimed), \
                patch.object(availability_import, "_run_parser_subprocess", parser):
            result = await availability_import.process_availability_import(payload, 0)

        self.assertEqual(result, {"skipped": True, "status": "terminal"})
        parser.assert_not_called()

    async def test_durable_envelope_survives_deleted_local_source(self):
        source = b"%PDF-1.7\nrestart-safe"
        with tempfile.TemporaryDirectory() as directory:
            deleted_path = Path(directory) / "deleted-on-restart.pdf"
            claimed = encrypted_claim(source, deleted_path)
            parsed_sources = []

            def parse(path):
                parsed_sources.append(path.read_bytes())
                return valid_parser_result()

            with patch.dict(
                os.environ,
                {"AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"z" * 32).hex()},
            ), patch.object(
                availability_import,
                "claim_import",
                return_value=claimed,
            ), patch.object(
                availability_import,
                "_run_parser_subprocess",
                side_effect=parse,
            ), patch.object(
                availability_import,
                "complete_import",
            ) as complete, patch.object(
                availability_import,
                "cleanup_source",
            ):
                result = await availability_import.process_availability_import(
                    {"import_id": "import-1", "tenant_id": "tenant-1"},
                    0,
                )

        self.assertEqual(parsed_sources, [source])
        self.assertEqual(result["rows"], 1)
        complete.assert_called_once()

    async def test_corrupt_durable_and_missing_local_source_is_retryable_infrastructure(self):
        source = b"%PDF-1.7\ncorrupt"
        claimed = encrypted_claim(source, Path("/missing/local-source.pdf"))
        corrupt_envelope = claimed.encrypted_source_payload[:-1] + bytes([
            claimed.encrypted_source_payload[-1] ^ 0x01
        ])
        corrupt = replace(claimed, encrypted_source_payload=corrupt_envelope)
        parser = MagicMock()
        terminalize = MagicMock()

        with patch.dict(
            os.environ,
            {"AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"z" * 32).hex()},
        ), patch.object(
            availability_import,
            "claim_import",
            return_value=corrupt,
        ), patch.object(
            availability_import,
            "_run_parser_subprocess",
            parser,
        ), patch.object(
            availability_import,
            "terminalize_import",
            terminalize,
        ):
            with self.assertRaises(availability_import_store.AvailabilityImportRetryable):
                await availability_import.process_availability_import(
                    {"import_id": "import-1", "tenant_id": "tenant-1"},
                    0,
                )

        parser.assert_not_called()
        terminalize.assert_not_called()

    def test_corrupt_durable_source_never_falls_back_to_a_local_copy(self):
        source = b"%PDF-1.7\nlocal-fallback"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / STORAGE_KEY
            claimed = encrypted_claim(source, path)
            path.write_bytes(claimed.encrypted_source_payload)
            corrupt = replace(claimed, encrypted_source_payload=b"corrupt")
            with patch.dict(os.environ, {"AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"z" * 32).hex()}):
                with self.assertRaises(availability_import.AvailabilityImportSourceUnavailable):
                    availability_import._recover_source_bytes(corrupt)

    def test_local_fallback_reads_only_an_authenticated_encrypted_envelope(self):
        source = b"%PDF-1.7\nencrypted-local-fallback"
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / STORAGE_KEY
            claimed = encrypted_claim(source, path)
            path.write_bytes(claimed.encrypted_source_payload)
            local_only = replace(claimed, encrypted_source_payload=None)

            with patch.dict(os.environ, {"AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"z" * 32).hex()}):
                self.assertEqual(availability_import._recover_source_bytes(local_only), source)

            self.assertNotEqual(path.read_bytes(), source)
            self.assertTrue(path.read_bytes().startswith(b"LLAI\x03"))

    async def test_aad_binding_tampering_fails_before_document_parsing(self):
        claimed = encrypted_claim(b"%PDF-1.7\naad-bound")
        tampered_claims = [
            replace(claimed, request_identity_hash="1" * 64),
            replace(claimed, target_identity_hash="2" * 64),
            replace(
                claimed,
                encrypted_source_payload=(
                    claimed.encrypted_source_payload[:4]
                    + b"\x02"
                    + claimed.encrypted_source_payload[5:]
                ),
            ),
        ]

        for tampered in tampered_claims:
            with self.subTest(tampered=tampered), patch.dict(
                os.environ,
                {"AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"z" * 32).hex()},
            ), patch.object(
                availability_import,
                "claim_import",
                return_value=tampered,
            ), patch.object(
                availability_import,
                "_run_parser_subprocess",
            ) as parser:
                with self.assertRaises(availability_import_store.AvailabilityImportRetryable):
                    await availability_import.process_availability_import(
                        {"import_id": "import-1", "tenant_id": "tenant-1"},
                        0,
                    )
                parser.assert_not_called()

    def test_worker_rechecks_pdf_signature_after_authenticated_decryption(self):
        claimed = encrypted_claim(b"not-a-pdf", None)
        with patch.dict(os.environ, {"AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"z" * 32).hex()}):
            with self.assertRaises(availability_import.AvailabilityImportSourceUnavailable):
                availability_import._recover_source_bytes(claimed)

    def test_production_config_requires_a_distinct_exact_32_byte_key(self):
        with patch.dict(os.environ, {"ENVIRONMENT": "production"}, clear=True):
            with self.assertRaisesRegex(RuntimeError, "decode to exactly 32 bytes"):
                availability_import.validate_availability_import_config()
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "production",
                "AVAILABILITY_IMPORT_ENCRYPTION_KEY": "short",
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "decode to exactly 32 bytes"):
                availability_import.validate_availability_import_config()
        with patch.dict(
            os.environ,
            {
                "ENVIRONMENT": "production",
                "AVAILABILITY_IMPORT_ENCRYPTION_KEY": (b"k" * 32).hex(),
                "PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY": (b"k" * 32).hex(),
            },
            clear=True,
        ):
            with self.assertRaisesRegex(RuntimeError, "must not reuse"):
                availability_import.validate_availability_import_config()

    async def test_invalid_parser_result_terminalizes_and_cleans_the_source(self):
        payload = {"import_id": "import-1", "tenant_id": "tenant-1"}
        claimed = availability_import_store.ClaimedImport(
            availability_import_store.ImportPayload("import-1", "tenant-1"),
            "execution-token",
            Path("/tmp/source.pdf"),
            "a" * 64,
            9,
            "claimed",
        )

        with patch.object(availability_import, "claim_import", return_value=claimed), \
                patch.object(
                    availability_import,
                    "_parse_claimed_source",
                    side_effect=availability_import_store.AvailabilityImportRejected("invalid"),
                ), \
                patch.object(availability_import, "terminalize_import", return_value=None) as terminalize, \
                patch.object(availability_import, "cleanup_source") as cleanup:
            with self.assertRaises(availability_import_store.AvailabilityImportRejected):
                await availability_import.process_availability_import(payload, 0)

        terminalize.assert_called_once()
        terminal_args = terminalize.call_args.args
        self.assertEqual(terminal_args[0], claimed.payload)
        self.assertRegex(terminal_args[1], r"^[a-f0-9]{32}$")
        self.assertEqual(terminal_args[2:], ("FAILED", "INVALID_DOCUMENT"))
        cleanup.assert_called_once_with(claimed.payload, claimed.path)

    def test_parser_child_receives_socket_and_normalized_timeout_without_parent_secrets(self):
        for raw_timeout, expected in [("2.5", 2.5), ("999", 30.0), ("0", 1.0), ("invalid", 15.0)]:
            with self.subTest(timeout=raw_timeout):
                process = MagicMock()
                process.wait.return_value = 0

                def launch(*args, **kwargs):
                    kwargs["stdout"].write(b'{"parsedAvailability": []}')
                    kwargs["stdout"].flush()
                    return process

                with patch.dict(os.environ, {
                    "PARSER_SOCKET_PATH": "/run/custom-parser/private.sock",
                    "WORKER_PDF_PARSE_TIMEOUT_SECONDS": raw_timeout,
                    "DATABASE_URL": "postgresql://synthetic-secret",
                    "STRIPE_SECRET_KEY": "synthetic-provider-secret",
                    "UNRELATED_PARENT_SECRET": "do-not-forward",
                }), patch.object(availability_import.subprocess, "Popen", side_effect=launch) as popen:
                    self.assertEqual(availability_import._run_parser_subprocess(Path("availability.pdf")),
                                     {"parsedAvailability": []})
                child_env = popen.call_args.kwargs["env"]
                self.assertEqual(child_env["PARSER_SOCKET_PATH"], "/run/custom-parser/private.sock")
                self.assertEqual(child_env["WORKER_PDF_PARSE_TIMEOUT_SECONDS"], str(expected))
                process.wait.assert_called_once_with(timeout=expected)
                for secret in ("DATABASE_URL", "STRIPE_SECRET_KEY", "UNRELATED_PARENT_SECRET"):
                    self.assertNotIn(secret, child_env)
                self.assertTrue(popen.call_args.kwargs["close_fds"])
                process.kill.assert_not_called()

    def test_parser_timeout_kills_and_reaps_the_subprocess(self):
        process = MagicMock()
        process.wait.side_effect = [
            subprocess.TimeoutExpired(cmd="pdf_sandbox", timeout=1),
            0,
        ]

        with patch.object(availability_import.subprocess, "Popen", return_value=process):
            with self.assertRaisesRegex(
                availability_import_store.AvailabilityImportRejected,
                "timed out",
            ):
                availability_import._run_parser_subprocess(Path("availability.pdf"))

        process.kill.assert_called_once()
        self.assertEqual(process.wait.call_count, 2)

    def test_parser_result_is_bounded_and_rejects_duplicate_rows(self):
        row = {"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020}
        with self.assertRaisesRegex(
            availability_import_store.AvailabilityImportRejected,
            "result is invalid",
        ):
            availability_import._validate_result({
                "sourceStaffIdentityHash": TARGET_IDENTITY_HASH,
                "parsedAvailability": [row, row],
            })


if __name__ == "__main__":
    unittest.main()
