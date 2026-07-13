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
    def __init__(self, item):
        self.item = item
        self.delivered = []
        self.failed = []

    def claim(self, _outbox_id=None):
        item, self.item = self.item, None
        return item

    def mark_delivered(self, item):
        self.delivered.append(item)

    def mark_failed(self, item, message, terminal):
        self.failed.append((item, message, terminal))

    def dead_lettered_count(self):
        return sum(1 for _, _, terminal in self.failed if terminal)

    def terminalize_stranded(self):
        return 0


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
        "outbox-1", "tenant-1", envelope,
        __import__("hashlib").sha256(key).hexdigest()[:16], attempts,
    )


class PasswordResetEmailTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.env = patch.dict(os.environ, {
            "PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY": "11" * 32,
            "PASSWORD_RESET_EMAIL_MAX_ATTEMPTS": "3",
            "RESEND_API_KEY": "re_test",
            "EMAIL_FROM": "LunchLineup <noreply@example.com>",
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

    async def test_retries_transient_provider_failure_below_bound(self):
        store = FakeStore(encrypted_item(attempts=2))
        with patch.object(reset_email, "send_with_resend", side_effect=reset_email.RetryableEmailError("provider unavailable")):
            with self.assertRaises(reset_email.RetryableEmailError):
                await reset_email.dispatch_password_reset_email(store=store)
        self.assertEqual(store.failed[0][2], False)

    async def test_dead_letters_final_attempt_for_alerting(self):
        store = FakeStore(encrypted_item(attempts=3))
        with patch.object(reset_email, "send_with_resend", side_effect=reset_email.RetryableEmailError("provider unavailable")):
            with self.assertRaises(reset_email.NonRetryableEmailError):
                await reset_email.dispatch_password_reset_email(store=store)
        self.assertEqual(store.failed[0][2], True)
        self.assertEqual(store.dead_lettered_count(), 1)


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
            {"delivered": 0, "dead_lettered": 0, "terminalized": 0},
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


if __name__ == "__main__":
    unittest.main()
