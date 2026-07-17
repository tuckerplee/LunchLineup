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
from unittest.mock import MagicMock, patch

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
                False,
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
        self.refund_count = 0
        self.refund_attempts = 0
        self.wallet_updates = 0
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
                True,
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
            )
        elif compact.startswith('INSERT INTO "CreditTransaction"'):
            self.state.refund_attempts += 1
            if self.state.refund_count:
                self.result = None
            else:
                self.state.refund_count = 1
                self.result = ("refund-1",)
        elif compact.startswith('UPDATE "Tenant" SET "usageCredits"'):
            self.state.wallet_updates += 1
            self.result = (5,)
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
            )
        elif compact.startswith('INSERT INTO "CreditTransaction"'):
            self.state.refund_attempts += 1
            refund_id, tenant_id, amount, reason, balance_after = params
            if refund_id in self.state.ledger:
                self.result = None
            else:
                self.state.ledger[refund_id] = (tenant_id, amount, reason, balance_after)
                self.result = (refund_id,)
        elif compact.startswith('UPDATE "Tenant" SET "usageCredits"'):
            self.state.wallet_updates += 1
            self.result = (5,)
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


class AvailabilityImportStoreTests(unittest.TestCase):
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
        source = inspect.getsource(availability_import_store.sweep_expired_imports)

        self.assertIn('"completedAt" <= CURRENT_TIMESTAMP - INTERVAL \'24 hours\'', source)
        self.assertIn('"resultErasedAt" = COALESCE("resultErasedAt", CURRENT_TIMESTAMP)', source)
        self.assertIn('"encryptedSourcePayload" = NULL', source)
        self.assertIn("'CANCELLED'", source)
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
        self.assertIn('WHEN %s IS NULL THEN', terminal_sql)
        self.assertIn('"executionLeaseUntil" <= CURRENT_TIMESTAMP', terminal_sql)
        self.assertIn('ELSE "executionToken" = %s', terminal_sql)
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
