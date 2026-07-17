import asyncio
import base64
import json
import os
from pathlib import Path
import sys
import unittest
from unittest.mock import AsyncMock, patch

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

from src import password_reset_email as reset_email  # noqa: E402


class FakeStore:
    def __init__(self, item, deliverable=True, provider_health=None):
        self.item = list(item) if isinstance(item, list) else item
        self.deliverable = deliverable
        self.provider_health = provider_health
        self.delivered = []
        self.failed = []
        self.payload_erased = False

    def claim(self, _outbox_id=None):
        if isinstance(self.item, list):
            return self.item.pop(0) if self.item else None
        item, self.item = self.item, None
        return item

    def deliver_if_eligible(self, item, _email, deliver):
        if not self.deliverable:
            self.failed.append((item, "PASSWORD_RESET_EMAIL_RECIPIENT_BLOCKED", True))
            self.payload_erased = True
            return False
        deliver()
        self.delivered.append(item)
        self.payload_erased = True
        return True

    def mark_delivered(self, item):
        self.delivered.append(item)

    def mark_failed(self, item, message, terminal):
        self.failed.append((item, message, terminal))
        if terminal:
            self.payload_erased = True

    def dead_lettered_count(self):
        return sum(1 for _, _, terminal in self.failed if terminal)

    def last_dead_letter_unixtime(self):
        return 123.0 if self.dead_lettered_count() else 0.0

    def recent_provider_failures(self, _window_seconds):
        if self.provider_health is not None:
            return self.provider_health
        failures = sum(
            item.attempts for item, message, _terminal in self.failed
            if message.startswith("PASSWORD_RESET_EMAIL_PROVIDER_")
        )
        return failures, 123.0 if failures else 0.0

    def terminalize_stranded(self):
        return 0

class RecordingCursor:
    def __init__(self, rows=None):
        self.calls = []
        self.rowcount = 1
        self.rows = list(rows or [])

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def fetchone(self):
        return self.rows.pop(0) if self.rows else None


class RecordingConnection:
    def __init__(self, rows=None):
        self.cursor_instance = RecordingCursor(rows)

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def cursor(self):
        return self.cursor_instance


def encrypted_item(attempts=1):
    key = bytes.fromhex("11" * 32)
    iv = bytes.fromhex("22" * 12)
    plaintext = json.dumps({
        "email": "legacy@example.com",
        "resetUrl": "https://app.example.com/auth/reset-password?token=secret-token",
        "expiresAt": "2026-07-12T12:00:00.000Z",
    }).encode()
    encrypted = AESGCM(key).encrypt(iv, plaintext, None)
    envelope = json.dumps({
        "v": 1, "alg": "aes-256-gcm", "iv": base64.b64encode(iv).decode(),
        "tag": base64.b64encode(encrypted[-16:]).decode(),
        "ciphertext": base64.b64encode(encrypted[:-16]).decode(),
    })
    return reset_email.ResetEmail(
        "outbox-1", "tenant-1", "user-1", envelope,
        __import__("hashlib").sha256(key).hexdigest()[:16], attempts,
    )


class PasswordResetEmailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY": "11" * 32,
            "PASSWORD_RESET_EMAIL_MAX_ATTEMPTS": "3",
            "RESEND_API_KEY": "re_test",
            "EMAIL_FROM": "LunchLineup <noreply@example.com>",
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "test-capability",
        })
        self.env.start()

    def tearDown(self):
        self.env.stop()

    def test_decrypts_node_compatible_envelope_without_persisting_plaintext(self):
        item = encrypted_item()
        payload = reset_email.decrypt_envelope(item)
        self.assertEqual(payload["email"], "legacy@example.com")
        self.assertIn("secret-token", payload["resetUrl"])
        self.assertNotIn("legacy@example.com", item.encrypted_payload)
        self.assertNotIn("secret-token", item.encrypted_payload)

    async def test_marks_success_delivered(self):
        store = FakeStore(encrypted_item())
        with patch.object(reset_email, "send_with_resend") as send:
            result = await reset_email.dispatch_password_reset_email(store=store)
        self.assertEqual(result, {"delivered": True, "outbox_id": "outbox-1"})
        self.assertEqual(len(store.delivered), 1)
        self.assertEqual(store.failed, [])
        send.assert_called_once()

    async def test_does_not_overwrite_state_when_final_handoff_loses_lease(self):
        store = FakeStore(encrypted_item())

        def lose_lease(_item, _email, _deliver):
            raise reset_email.OutboxLeaseLostError("lease lost")

        store.deliver_if_eligible = lose_lease
        with patch.object(reset_email, "send_with_resend"):
            with self.assertRaises(reset_email.OutboxLeaseLostError):
                await reset_email.dispatch_password_reset_email(store=store)

        self.assertEqual(store.failed, [])

    async def test_dead_letters_lifecycle_block_without_provider_handoff(self):
        store = FakeStore(encrypted_item(), deliverable=False)
        with patch.object(reset_email, "send_with_resend") as send:
            with self.assertRaises(reset_email.NonRetryableEmailError):
                await reset_email.dispatch_password_reset_email(store=store)

        send.assert_not_called()
        self.assertEqual(len(store.failed), 1)
        self.assertEqual(store.failed[0][2], True)
        self.assertEqual(store.failed[0][1], "PASSWORD_RESET_EMAIL_RECIPIENT_BLOCKED")
        self.assertNotIn("legacy@example.com", store.failed[0][1])
        self.assertTrue(store.payload_erased)

    def test_claim_scrubs_blocked_lifecycle_rows_before_selecting_delivery(self):
        store = reset_email.PostgresResetEmailStore("postgresql://test")
        connection = RecordingConnection(rows=[None])

        with patch.object(store, "_connect", return_value=connection):
            self.assertIsNone(store.claim("outbox-1"))

        scrub_sql, scrub_params = connection.cursor_instance.calls[1]
        claim_sql, _claim_params = connection.cursor_instance.calls[2]
        for lifecycle_clause in (
            'recipient."deletedAt" IS NOT NULL',
            'recipient."suspendedAt" IS NOT NULL',
            'recipient."emailDeliverySuppressedAt" IS NOT NULL',
            'tenant."deletedAt" IS NOT NULL',
            'tenant."status" IN (\'SUSPENDED\', \'PURGED\')',
        ):
            self.assertIn(lifecycle_clause, scrub_sql)
        self.assertEqual(scrub_params[1:3], ("", "erased-v1"))
        self.assertIn("PASSWORD_RESET_EMAIL_RECIPIENT_BLOCKED", scrub_sql)
        self.assertIn('recipient."suspendedAt" IS NULL', claim_sql)
        self.assertIn('tenant."status" NOT IN (\'SUSPENDED\', \'PURGED\')', claim_sql)
        self.assertIn("FOR UPDATE OF outbox SKIP LOCKED", claim_sql)

    def test_final_handoff_rejects_user_deletion_suspension_and_suppression_races(self):
        item = encrypted_item()
        blocked_recipients = {
            "deleted": (object(), None, None, True),
            "suspended": (None, object(), None, True),
            "suppressed": (None, None, object(), True),
        }

        for state, recipient in blocked_recipients.items():
            with self.subTest(state=state):
                store = reset_email.PostgresResetEmailStore("postgresql://test")
                connection = RecordingConnection(rows=[(None, "ACTIVE"), recipient])
                handed_off = []
                with patch.object(store, "_connect", return_value=connection):
                    delivered = store.deliver_if_eligible(item, "legacy@example.com", lambda: handed_off.append(True))

                self.assertFalse(delivered)
                self.assertEqual(handed_off, [])
                terminal_sql, terminal_params = connection.cursor_instance.calls[-1]
                self.assertIn("PASSWORD_RESET_EMAIL_RECIPIENT_BLOCKED", terminal_sql)
                self.assertEqual(terminal_params[1:3], ("", "erased-v1"))

    def test_final_handoff_rejects_deleted_suspended_and_purged_tenant_races(self):
        item = encrypted_item()
        blocked_tenants = {
            "deleted": (object(), "ACTIVE"),
            "suspended": (None, "SUSPENDED"),
            "purged": (None, "PURGED"),
        }

        for state, tenant in blocked_tenants.items():
            with self.subTest(state=state):
                store = reset_email.PostgresResetEmailStore("postgresql://test")
                connection = RecordingConnection(rows=[tenant])
                handed_off = []
                with patch.object(store, "_connect", return_value=connection):
                    delivered = store.deliver_if_eligible(item, "legacy@example.com", lambda: handed_off.append(True))

                self.assertFalse(delivered)
                self.assertEqual(handed_off, [])
                _terminal_sql, terminal_params = connection.cursor_instance.calls[-1]
                self.assertEqual(terminal_params[1:3], ("", "erased-v1"))

    def test_provider_handoff_occurs_only_after_lifecycle_and_lease_rows_are_locked(self):
        item = encrypted_item()
        store = reset_email.PostgresResetEmailStore("postgresql://test")
        connection = RecordingConnection(rows=[
            (None, "ACTIVE"),
            (None, None, None, True),
            (1,),
        ])
        call_count_at_handoff = []

        with patch.object(store, "_connect", return_value=connection):
            delivered = store.deliver_if_eligible(
                item,
                "legacy@example.com",
                lambda: call_count_at_handoff.append(len(connection.cursor_instance.calls)),
            )

        self.assertTrue(delivered)
        self.assertEqual(call_count_at_handoff, [4])
        lock_sql = "\n".join(sql for sql, _params in connection.cursor_instance.calls[1:4])
        self.assertEqual(lock_sql.count("FOR UPDATE"), 3)
        delivered_sql, delivered_params = connection.cursor_instance.calls[-1]
        self.assertIn("'DELIVERED'", delivered_sql)
        self.assertEqual(delivered_params[1:3], ("", "erased-v1"))

    def test_database_transition_fails_when_the_claim_is_no_longer_owned(self):
        item = encrypted_item()
        store = reset_email.PostgresResetEmailStore("postgresql://test")
        connection = RecordingConnection()
        connection.cursor_instance.rowcount = 0

        with patch.object(store, "_connect", return_value=connection):
            with self.assertRaises(reset_email.OutboxLeaseLostError):
                store.mark_delivered(item)

    async def test_retries_transient_provider_failure_below_bound(self):
        store = FakeStore(encrypted_item(attempts=2))
        secret = "resend_api_key=secret https://private.example.test/reset?token=leak"
        with patch.object(reset_email, "send_with_resend", side_effect=reset_email.RetryableEmailError(secret)):
            with self.assertRaises(reset_email.RetryableEmailError):
                await reset_email.dispatch_password_reset_email(store=store)
        self.assertEqual(store.failed[0][2], False)
        self.assertEqual(store.failed[0][1], "PASSWORD_RESET_EMAIL_RETRYABLE")

    async def test_dead_letters_final_attempt_for_alerting(self):
        store = FakeStore(encrypted_item(attempts=3))
        secret = "resend_api_key=secret https://private.example.test/reset?token=leak"
        with patch.object(reset_email, "send_with_resend", side_effect=reset_email.RetryableEmailError(secret)):
            with self.assertRaises(reset_email.NonRetryableEmailError):
                await reset_email.dispatch_password_reset_email(store=store)
        self.assertEqual(store.failed[0][2], True)
        self.assertEqual(store.failed[0][1], "PASSWORD_RESET_EMAIL_RETRIES_EXHAUSTED")
        self.assertEqual(store.dead_lettered_count(), 1)

    def test_resend_400_is_a_terminal_provider_failure_without_response_leakage(self):
        item = encrypted_item()
        payload = reset_email.decrypt_envelope(item)
        provider_error = reset_email.error.HTTPError(
            "https://api.resend.com/emails",
            400,
            "provider body with recipient secret",
            None,
            None,
        )
        with patch.object(reset_email.request, "urlopen", side_effect=provider_error):
            with self.assertRaisesRegex(reset_email.ProviderRejectedEmailError, "provider rejected") as raised:
                reset_email.send_with_resend(item, payload)
        self.assertNotIn("recipient secret", str(raised.exception))

    async def test_single_provider_rejection_alerts_but_does_not_claim_systemic_outage(self):
        store = FakeStore(encrypted_item())
        with patch.object(
            reset_email,
            "send_with_resend",
            side_effect=reset_email.ProviderRejectedEmailError("bounded provider rejection"),
        ):
            result = await reset_email.sweep_password_reset_email_outbox(store, batch_size=1)

        self.assertEqual(result["provider_terminal"], 1)
        self.assertEqual(result["recent_provider_failures"], 1)
        self.assertEqual(result["systemic_provider_failure"], 0)
        self.assertEqual(store.failed[0][1], "PASSWORD_RESET_EMAIL_PROVIDER_REJECTED")

    async def test_repeated_recent_provider_failures_fail_closed_at_bounded_threshold(self):
        store = FakeStore(None, provider_health=(3, 123.0))
        with (
            patch.object(reset_email.SWEEP_RECENT_PROVIDER_FAILURES, "set") as recent_set,
            patch.object(reset_email.SWEEP_LAST_PROVIDER_FAILURE, "set") as last_failure_set,
            patch.object(reset_email.SWEEP_SYSTEMIC_PROVIDER_FAILURE, "set") as systemic_set,
        ):
            result = await reset_email.sweep_password_reset_email_outbox(store, batch_size=1)

        self.assertEqual(result["systemic_provider_failure"], 1)
        recent_set.assert_called_once_with(3)
        last_failure_set.assert_called_once_with(123.0)
        systemic_set.assert_called_once_with(1)

    async def test_repeated_401_and_403_failures_trip_readiness_after_terminal_erasure(self):
        store = FakeStore(
            [encrypted_item(), encrypted_item(), encrypted_item()],
            provider_health=(0, 0.0),
        )
        provider_errors = [
            reset_email.error.HTTPError(
                "https://api.resend.com/emails",
                status,
                "provider authentication rejected",
                None,
                None,
            )
            for status in (401, 403, 401)
        ]

        with patch.object(
            reset_email.request,
            "urlopen",
            side_effect=provider_errors,
        ):
            result = await reset_email.sweep_password_reset_email_outbox(
                store,
                batch_size=3,
            )

        self.assertEqual(result["provider_terminal"], 3)
        self.assertEqual(result["recent_provider_failures"], 3)
        self.assertEqual(result["systemic_provider_failure"], 1)
        self.assertTrue(store.payload_erased)
        self.assertEqual([terminal for _, _, terminal in store.failed], [True, True, True])
        self.assertEqual(store.recent_provider_failures(300), (0, 0.0))

    def test_terminal_database_updates_erase_encrypted_envelopes(self):
        item = encrypted_item()
        store = reset_email.PostgresResetEmailStore("postgresql://test")

        delivered_connection = RecordingConnection()
        with patch.object(store, "_connect", return_value=delivered_connection):
            store.mark_delivered(item)
        delivered_sql, delivered_params = delivered_connection.cursor_instance.calls[-1]
        self.assertIn('"encryptedPayload" = %s', delivered_sql)
        self.assertEqual(delivered_params[1:3], ("", "erased-v1"))

        terminal_connection = RecordingConnection()
        with patch.object(store, "_connect", return_value=terminal_connection):
            store.mark_failed(item, "permanent failure", terminal=True)
        terminal_sql, terminal_params = terminal_connection.cursor_instance.calls[-1]
        self.assertIn('"encryptedPayload" = %s', terminal_sql)
        self.assertEqual(terminal_params[3:5], ("", "erased-v1"))

    def test_retryable_database_update_preserves_encrypted_envelope(self):
        item = encrypted_item()
        store = reset_email.PostgresResetEmailStore("postgresql://test")
        connection = RecordingConnection()

        with patch.object(store, "_connect", return_value=connection):
            store.mark_failed(item, "temporary failure", terminal=False)

        _sql, params = connection.cursor_instance.calls[-1]
        self.assertEqual(params[3:5], (item.encrypted_payload, item.encryption_key_ref))

    async def test_sweep_loop_retries_after_transient_cycle_failure(self):
        store = FakeStore(None)
        sweep = AsyncMock(side_effect=[
            RuntimeError("database unavailable"),
            asyncio.CancelledError(),
        ])
        sleep = AsyncMock(return_value=None)

        with (
            patch.object(reset_email, "sweep_password_reset_email_outbox", sweep),
            patch.object(reset_email.asyncio, "sleep", sleep),
            patch.object(reset_email.SWEEP_FAILURES, "inc") as failure_inc,
            patch.object(reset_email.SWEEP_RUNNING, "set") as running_set,
            patch.object(reset_email.SWEEP_READY, "set") as ready_set,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await reset_email.run_password_reset_email_loop(store)

        self.assertEqual(sweep.await_count, 2)
        failure_inc.assert_called_once_with()
        self.assertEqual(running_set.call_args_list[0].args, (1,))
        self.assertEqual(running_set.call_args_list[-1].args, (0,))
        self.assertEqual(ready_set.call_args_list[-1].args, (0,))

    async def test_sweep_loop_reports_success_and_resets_readiness_on_shutdown(self):
        store = FakeStore(None)
        sweep = AsyncMock(side_effect=[
            {"delivered": 0, "dead_lettered": 0, "terminalized": 0, "recent_provider_failures": 0, "systemic_provider_failure": 0},
            asyncio.CancelledError(),
        ])
        sleep = AsyncMock(return_value=None)

        with (
            patch.object(reset_email, "sweep_password_reset_email_outbox", sweep),
            patch.object(reset_email.asyncio, "sleep", sleep),
            patch.object(reset_email.SWEEP_RUNNING, "set") as running_set,
            patch.object(reset_email.SWEEP_READY, "set") as ready_set,
            patch.object(reset_email.SWEEP_LAST_SUCCESS, "set_to_current_time") as last_success,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await reset_email.run_password_reset_email_loop(store)

        last_success.assert_called_once_with()
        self.assertIn((1,), [item.args for item in ready_set.call_args_list])
        self.assertEqual(ready_set.call_args_list[-1].args, (0,))
        self.assertEqual(running_set.call_args_list[-1].args, (0,))

    async def test_sweep_loop_stays_unready_until_systemic_provider_failure_recovers(self):
        store = FakeStore(None)
        sweep = AsyncMock(side_effect=[
            {"recent_provider_failures": 3, "systemic_provider_failure": 1},
            {"recent_provider_failures": 0, "systemic_provider_failure": 0},
            asyncio.CancelledError(),
        ])
        sleep = AsyncMock(return_value=None)

        with (
            patch.object(reset_email, "sweep_password_reset_email_outbox", sweep),
            patch.object(reset_email.asyncio, "sleep", sleep),
            patch.object(reset_email.SWEEP_RUNNING, "set"),
            patch.object(reset_email.SWEEP_READY, "set") as ready_set,
            patch.object(reset_email.SWEEP_SYSTEMIC_PROVIDER_FAILURE, "set") as systemic_set,
            patch.object(reset_email.SWEEP_LAST_SUCCESS, "set_to_current_time") as last_success,
        ):
            with self.assertRaises(asyncio.CancelledError):
                await reset_email.run_password_reset_email_loop(store)

        readiness = [call.args[0] for call in ready_set.call_args_list]
        self.assertEqual(readiness[:3], [0, 0, 1])
        self.assertEqual(readiness[-1], 0)
        last_success.assert_called_once_with()
        self.assertIn((1,), [call.args for call in systemic_set.call_args_list])
        self.assertEqual(systemic_set.call_args_list[-1].args, (0,))


if __name__ == "__main__":
    unittest.main()
