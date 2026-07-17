from __future__ import annotations

import asyncio
import base64
from dataclasses import replace
from datetime import datetime, timezone
import hashlib
import hmac
import json
import os
from unittest import IsolatedAsyncioTestCase, TestCase
from unittest.mock import patch
from urllib import error

from cryptography.hazmat.primitives.ciphers.aead import AESGCM

from src import staff_invitation_outbox as delivery
from src.staff_invitation_store import (
    GlobalClaimCapabilityError,
    InvitationDiagnostics,
    InvitationItem,
    PostgresInvitationStore,
)


KEY = bytes(range(32))
RECIPIENT = "staff@example.test"
API_FIXTURE_RECIPIENT_HASH = "e6eeeaef063fdf1a016d26d05e9e21e97d81a7d4d18e54652d2ad33f336fcffa"
API_FIXTURE_AAD = (
    b'{"tenantId":"tenant-1","outboxId":"api-fixture-1","userId":"user-1",'
    b'"recipientHash":"e6eeeaef063fdf1a016d26d05e9e21e97d81a7d4d18e54652d2ad33f336fcffa",'
    b'"purpose":"STAFF_INVITATION","payloadVersion":1}'
)
API_FIXTURE_CIPHERTEXT = bytes.fromhex(
    "3c20a47ea68cb272e82fe3a98bcb0b19e2b0e17495033e11480b80ab690c73c6"
    "233c8c88caac62f415d01acfb2a55b4c8f3f06d233b8d5b34bf65e70778dd793"
)
API_FIXTURE_TAG = bytes.fromhex("324ba99d4ed5083e825d084c7cbb31a6")


def encrypted_item(*, attempts: int = 1, item_id: str = "outbox-1") -> InvitationItem:
    recipient_hash = hmac.new(KEY, RECIPIENT.encode("utf-8"), hashlib.sha256).hexdigest()
    nonce = bytes(range(12))
    base = InvitationItem(
        id=item_id,
        tenant_id="tenant-1",
        user_id="user-1",
        recipient_hash=recipient_hash,
        purpose="STAFF_INVITATION",
        encrypted_payload=b"pending",
        encryption_nonce=nonce,
        encryption_tag=b"pending",
        encryption_key_ref=hashlib.sha256(KEY).hexdigest()[:16],
        payload_version=1,
        attempts=attempts,
        lease_owner="worker-1",
    )
    encrypted = AESGCM(KEY).encrypt(
        nonce,
        json.dumps({
            "recipient": RECIPIENT,
            "template": "staff_invitation",
        }, separators=(",", ":")).encode("utf-8"),
        delivery.invitation_aad(base),
    )
    return replace(base, encrypted_payload=encrypted[:-16], encryption_tag=encrypted[-16:])


class FakeStore:
    def __init__(self, items=None, outcomes=None, max_attempts=8):
        self.items = list(items or [])
        self.outcomes = list(outcomes or ["delivered"])
        self.max_attempts = max_attempts
        self.failed = []
        self.claim_limits = []
        self.provider_ids = []
        self.diagnostic = InvitationDiagnostics(0, 0, 0, 0, 0.0, 0.0)

    def claim_batch(self, limit):
        self.claim_limits.append(limit)
        claimed, self.items = self.items[:limit], self.items[limit:]
        return claimed

    def deliver_if_eligible(self, item, recipient_email, deliver):
        if recipient_email != RECIPIENT:
            raise AssertionError("unexpected recipient passed to final lifecycle barrier")
        outcome = self.outcomes.pop(0)
        if outcome == "delivered":
            self.provider_ids.append(deliver())
        return outcome

    def mark_failed(self, item, error_code, terminal):
        self.failed.append((item, error_code, terminal))

    def diagnostics(self, _provider_window_seconds):
        return self.diagnostic


class FakeProvider:
    def __init__(self, outcomes=None):
        self.outcomes = list(outcomes or ["provider-1"])
        self.items = []
        self.payloads = []

    def send(self, item, payload):
        self.items.append(item)
        self.payloads.append(payload)
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeHttpResponse:
    status = 200

    def __init__(self, provider_id="provider-message-1"):
        self.provider_id = provider_id

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def read(self, _limit):
        return json.dumps({"id": self.provider_id}).encode("utf-8")


class QueryCursor:
    def __init__(self, rows=None, capability=True):
        self.rows = list(rows or [])
        self.capability = capability
        self.calls = []
        self.rowcount = 1
        self._last_sql = ""

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        self._last_sql = sql
        self.calls.append((sql, params))

    def fetchone(self):
        if "is_current_platform_admin" in self._last_sql:
            return (self.capability,)
        return self.rows[0] if self.rows else None

    def fetchall(self):
        return self.rows


class QueryConnection:
    def __init__(self, cursor):
        self.cursor_value = cursor

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def cursor(self):
        return self.cursor_value


class InvitationDeliveryTests(IsolatedAsyncioTestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY": KEY.hex(),
            "RESEND_API_KEY": "re_test_secret",
            "EMAIL_FROM": "LunchLineup <noreply@example.test>",
            "APP_ORIGIN": "https://app.example.test",
        }, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    async def test_delivery_decrypts_and_marks_provider_success(self):
        item = encrypted_item()
        store = FakeStore(outcomes=["delivered"])
        provider = FakeProvider(["provider-message-1"])

        outcome = await delivery.deliver_invitation(item, store=store, provider=provider)

        self.assertEqual(outcome, "delivered")
        self.assertEqual(store.provider_ids, ["provider-message-1"])
        self.assertEqual(provider.payloads, [{
            "recipient": RECIPIENT,
            "template": "staff_invitation",
        }])

    async def test_final_handoff_cancellation_never_calls_provider(self):
        store = FakeStore(outcomes=["cancelled"])
        provider = FakeProvider([])

        outcome = await delivery.deliver_invitation(
            encrypted_item(), store=store, provider=provider
        )

        self.assertEqual(outcome, "cancelled")
        self.assertEqual(provider.items, [])

    async def test_final_handoff_suppression_is_distinct_and_never_calls_provider(self):
        store = FakeStore(outcomes=["suppressed"])
        provider = FakeProvider([])

        outcome = await delivery.deliver_invitation(
            encrypted_item(), store=store, provider=provider
        )

        self.assertEqual(outcome, "suppressed")
        self.assertEqual(provider.items, [])

    async def test_transient_failure_retries_then_dead_letters_at_attempt_bound(self):
        retry_item = encrypted_item(attempts=2)
        retry_store = FakeStore(max_attempts=8)
        retry_provider = FakeProvider([delivery.RetryableProviderError("secret provider detail")])

        with self.assertRaises(delivery.RetryableInvitationError):
            await delivery.deliver_invitation(
                retry_item, store=retry_store, provider=retry_provider
            )
        self.assertEqual(retry_store.failed[0][1:], ("PROVIDER_RETRYABLE", False))

        final_item = encrypted_item(attempts=8)
        final_store = FakeStore(max_attempts=8)
        final_provider = FakeProvider([delivery.RetryableProviderError("secret provider detail")])
        with self.assertRaises(delivery.PermanentInvitationError):
            await delivery.deliver_invitation(
                final_item, store=final_store, provider=final_provider
            )
        self.assertEqual(final_store.failed[0][1:], ("RETRIES_EXHAUSTED", True))

    async def test_permanent_provider_rejection_dead_letters_immediately(self):
        store = FakeStore()
        provider = FakeProvider([delivery.ProviderRejectedError("recipient rejected")])

        with self.assertRaises(delivery.PermanentInvitationError):
            await delivery.deliver_invitation(
                encrypted_item(attempts=1), store=store, provider=provider
            )

        self.assertEqual(store.failed[0][1:], ("PROVIDER_REJECTED", True))

    def test_http_auth_configuration_failures_are_retryable(self):
        provider = delivery.ResendInvitationProvider(timeout_seconds=10)

        for status in (401, 403):
            with self.subTest(status=status), patch.object(
                delivery.request,
                "urlopen",
                side_effect=error.HTTPError(
                    "https://api.resend.com/emails", status, "rejected", None, None
                ),
            ):
                with self.assertRaises(delivery.ProviderAuthConfigurationError):
                    provider.send(
                        encrypted_item(),
                        {"recipient": RECIPIENT, "template": "staff_invitation"},
                    )

    def test_http_recipient_validation_failures_remain_permanent(self):
        provider = delivery.ResendInvitationProvider(timeout_seconds=10)

        for status in (400, 422):
            with self.subTest(status=status), patch.object(
                delivery.request,
                "urlopen",
                side_effect=error.HTTPError(
                    "https://api.resend.com/emails", status, "rejected", None, None
                ),
            ):
                with self.assertRaises(delivery.ProviderRejectedError):
                    provider.send(
                        encrypted_item(),
                        {"recipient": RECIPIENT, "template": "staff_invitation"},
                    )

    async def test_response_loss_reuses_provider_idempotency_key(self):
        captured_keys = []
        responses = [error.URLError("response lost"), FakeHttpResponse("provider-message-1")]

        def open_request(req, timeout):
            self.assertEqual(timeout, 10)
            captured_keys.append(req.get_header("Idempotency-key"))
            outcome = responses.pop(0)
            if isinstance(outcome, Exception):
                raise outcome
            return outcome

        first_store = FakeStore()
        second_store = FakeStore()
        provider = delivery.ResendInvitationProvider(timeout_seconds=10)
        with patch.object(delivery.request, "urlopen", side_effect=open_request):
            with self.assertRaises(delivery.RetryableInvitationError):
                await delivery.deliver_invitation(
                    encrypted_item(attempts=1), store=first_store, provider=provider
                )
            outcome = await delivery.deliver_invitation(
                encrypted_item(attempts=2), store=second_store, provider=provider
            )

        self.assertEqual(outcome, "delivered")
        self.assertEqual(captured_keys, [
            "staff-invitation/outbox-1",
            "staff-invitation/outbox-1",
        ])

    def test_reactivation_or_reissue_outbox_identity_creates_a_distinct_provider_action(self):
        captured_keys = []

        def open_request(req, timeout):
            self.assertEqual(timeout, 10)
            captured_keys.append(req.get_header("Idempotency-key"))
            return FakeHttpResponse(f"provider-message-{len(captured_keys)}")

        provider = delivery.ResendInvitationProvider(timeout_seconds=10)
        with patch.object(delivery.request, "urlopen", side_effect=open_request):
            provider.send(
                encrypted_item(item_id="archived-outbox"),
                {"recipient": RECIPIENT, "template": "staff_invitation"},
            )
            provider.send(
                encrypted_item(item_id="reactivated-outbox"),
                {"recipient": RECIPIENT, "template": "staff_invitation"},
            )

        self.assertEqual(captured_keys, [
            "staff-invitation/archived-outbox",
            "staff-invitation/reactivated-outbox",
        ])

    async def test_provider_includes_credential_free_login_link_in_html_and_text(self):
        captured = {}

        def open_request(req, timeout):
            captured["body"] = json.loads(req.data.decode("utf-8"))
            captured["timeout"] = timeout
            return FakeHttpResponse()

        with patch.dict(os.environ, {
            "APP_ORIGIN": "https://app.example.test/",
        }, clear=False), patch.object(delivery.request, "urlopen", side_effect=open_request):
            provider_id = delivery.ResendInvitationProvider(timeout_seconds=7).send(
                encrypted_item(),
                {"recipient": RECIPIENT, "template": "staff_invitation"},
            )

        self.assertEqual(provider_id, "provider-message-1")
        self.assertEqual(captured["timeout"], 7)
        self.assertIn(
            'href="https://app.example.test/auth/login"',
            captured["body"]["html"],
        )
        self.assertIn("https://app.example.test/auth/login", captured["body"]["text"])
        self.assertNotIn(RECIPIENT, captured["body"]["html"])
        self.assertNotIn(RECIPIENT, captured["body"]["text"])
        self.assertNotIn("?", captured["body"]["html"])

    async def test_secret_and_recipient_never_reach_logs_or_durable_code(self):
        secret = f"{RECIPIENT} re_private_key https://private.test?token=secret"
        store = FakeStore()
        provider = FakeProvider([delivery.RetryableProviderError(secret)])

        with self.assertLogs("worker.staff_invitation_outbox", level="WARNING") as logs:
            with self.assertRaises(delivery.RetryableInvitationError):
                await delivery.deliver_invitation(
                    encrypted_item(), store=store, provider=provider
                )

        output = " ".join(logs.output)
        self.assertNotIn(RECIPIENT, output)
        self.assertNotIn("re_private_key", output)
        self.assertNotIn("token=secret", output)
        self.assertEqual(store.failed[0][1], "PROVIDER_RETRYABLE")

    async def test_sweep_is_bounded_and_reports_health_diagnostics(self):
        store = FakeStore(items=[encrypted_item()], outcomes=["delivered"])
        store.diagnostic = InvitationDiagnostics(2, 1, 3, 3, 10.0, 11.0)

        result = await delivery.sweep_staff_invitation_outbox(
            store=store,
            provider=FakeProvider(["provider-1"]),
            batch_size=7,
        )

        self.assertEqual(store.claim_limits, [7])
        self.assertEqual(result["delivered"], 1)
        self.assertEqual(result["systemic_provider_failure"], 1)

    async def test_loop_publishes_fresh_readiness_then_fails_closed_on_shutdown(self):
        delivery.SWEEP_LAST_SUCCESS.set(0)
        observed = {}

        async def stop_after_first_sweep(interval):
            observed.update({
                "interval": interval,
                "running": delivery.SWEEP_RUNNING._value.get(),
                "ready": delivery.SWEEP_READY._value.get(),
                "last_success": delivery.SWEEP_LAST_SUCCESS._value.get(),
                "max_staleness": delivery.SWEEP_MAX_STALENESS._value.get(),
            })
            raise asyncio.CancelledError()

        with patch.object(delivery.asyncio, "sleep", side_effect=stop_after_first_sweep):
            with self.assertRaises(asyncio.CancelledError):
                await delivery.run_staff_invitation_outbox_loop(
                    store=FakeStore(),
                    provider=FakeProvider(),
                )

        self.assertEqual(observed["interval"], 10)
        self.assertEqual(observed["running"], 1)
        self.assertEqual(observed["ready"], 1)
        self.assertGreater(observed["last_success"], 0)
        self.assertEqual(observed["max_staleness"], 60)
        self.assertEqual(delivery.SWEEP_RUNNING._value.get(), 0)
        self.assertEqual(delivery.SWEEP_READY._value.get(), 0)

    async def test_loop_remains_not_ready_during_systemic_provider_failure(self):
        delivery.SWEEP_LAST_SUCCESS.set(0)
        store = FakeStore()
        store.diagnostic = InvitationDiagnostics(0, 0, 0, 3, 0.0, 1.0)
        observed = {}

        async def stop_after_first_sweep(_interval):
            observed.update({
                "ready": delivery.SWEEP_READY._value.get(),
                "systemic": delivery.SYSTEMIC_PROVIDER_FAILURE._value.get(),
                "last_success": delivery.SWEEP_LAST_SUCCESS._value.get(),
            })
            raise asyncio.CancelledError()

        with patch.object(delivery.asyncio, "sleep", side_effect=stop_after_first_sweep):
            with self.assertRaises(asyncio.CancelledError):
                await delivery.run_staff_invitation_outbox_loop(
                    store=store,
                    provider=FakeProvider(),
                )

        self.assertEqual(observed, {
            "ready": 0,
            "systemic": 1,
            "last_success": 0,
        })
        self.assertEqual(delivery.SYSTEMIC_PROVIDER_FAILURE._value.get(), 0)

    async def test_first_auth_configuration_failure_retries_and_fails_readiness(self):
        delivery.SWEEP_LAST_SUCCESS.set(0)
        item = encrypted_item(attempts=1)
        store = FakeStore(items=[item])
        provider = FakeProvider([
            delivery.ProviderAuthConfigurationError("secret provider detail")
        ])
        observed = []

        async def stop_after_idle_sweep(_interval):
            observed.append({
                "ready": delivery.SWEEP_READY._value.get(),
                "systemic": delivery.SYSTEMIC_PROVIDER_FAILURE._value.get(),
                "last_success": delivery.SWEEP_LAST_SUCCESS._value.get(),
            })
            if len(observed) == 2:
                raise asyncio.CancelledError()

        with patch.object(delivery.asyncio, "sleep", side_effect=stop_after_idle_sweep):
            with self.assertRaises(asyncio.CancelledError):
                await delivery.run_staff_invitation_outbox_loop(
                    store=store,
                    provider=provider,
                )

        self.assertEqual(store.failed, [(item, "PROVIDER_RETRYABLE", False)])
        self.assertEqual(observed, [
            {"ready": 0, "systemic": 1, "last_success": 0},
            {"ready": 0, "systemic": 1, "last_success": 0},
        ])
        self.assertEqual(delivery.SYSTEMIC_PROVIDER_FAILURE._value.get(), 0)

    async def test_loop_remains_running_but_not_ready_after_cycle_failure(self):
        delivery.SWEEP_LAST_SUCCESS.set(0)
        observed = {}

        async def stop_after_failed_sweep(_interval):
            observed.update({
                "running": delivery.SWEEP_RUNNING._value.get(),
                "ready": delivery.SWEEP_READY._value.get(),
                "last_success": delivery.SWEEP_LAST_SUCCESS._value.get(),
            })
            raise asyncio.CancelledError()

        with patch.object(
            delivery,
            "sweep_staff_invitation_outbox",
            side_effect=RuntimeError("secret database detail"),
        ), patch.object(
            delivery.asyncio,
            "sleep",
            side_effect=stop_after_failed_sweep,
        ), self.assertLogs("worker.staff_invitation_outbox", level="ERROR") as logs:
            with self.assertRaises(asyncio.CancelledError):
                await delivery.run_staff_invitation_outbox_loop(
                    store=FakeStore(),
                    provider=FakeProvider(),
                )

        self.assertEqual(observed, {
            "running": 1,
            "ready": 0,
            "last_success": 0,
        })
        self.assertNotIn("secret database detail", " ".join(logs.output))


class InvitationCryptoAndConfigTests(TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY": KEY.hex(),
        }, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_aad_has_exact_ordered_api_contract_including_payload_version(self):
        item = encrypted_item()

        self.assertEqual(
            delivery.invitation_aad(item),
            (
                b'{"tenantId":"tenant-1","outboxId":"outbox-1","userId":"user-1",'
                b'"recipientHash":"' + item.recipient_hash.encode("ascii")
                + b'","purpose":"STAFF_INVITATION","payloadVersion":1}'
            ),
        )

    def test_fixed_api_compatible_ciphertext_fixture_decrypts_in_worker(self):
        item = InvitationItem(
            id="api-fixture-1",
            tenant_id="tenant-1",
            user_id="user-1",
            recipient_hash=API_FIXTURE_RECIPIENT_HASH,
            purpose="STAFF_INVITATION",
            encrypted_payload=API_FIXTURE_CIPHERTEXT,
            encryption_nonce=bytes(range(12)),
            encryption_tag=API_FIXTURE_TAG,
            encryption_key_ref=hashlib.sha256(KEY).hexdigest()[:16],
            payload_version=1,
            attempts=1,
            lease_owner="worker-1",
        )

        self.assertEqual(delivery.invitation_aad(item), API_FIXTURE_AAD)
        self.assertEqual(delivery.decrypt_invitation(item), {
            "recipient": RECIPIENT,
            "template": "staff_invitation",
        })

    def test_aad_tamper_fails_authentication(self):
        item = encrypted_item()

        with self.assertRaises(delivery.InvalidInvitationEnvelope):
            delivery.decrypt_invitation(replace(item, user_id="user-tampered"))

    def test_ciphertext_and_recipient_hash_tamper_fail_closed(self):
        item = encrypted_item()
        with self.assertRaises(delivery.InvalidInvitationEnvelope):
            delivery.decrypt_invitation(replace(item, encrypted_payload=b"x" + item.encrypted_payload[1:]))
        with self.assertRaises(delivery.InvalidInvitationEnvelope):
            delivery.decrypt_invitation(replace(item, recipient_hash="0" * 64))

    def test_enabled_delivery_requires_global_capability_and_dedicated_valid_key(self):
        base = {
            "STAFF_INVITATION_OUTBOX_ENABLED": "true",
            "DATABASE_URL": "postgresql://worker@example.test/lunchlineup",
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "",
            "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY": KEY.hex(),
            "RESEND_API_KEY": "re_test_secret",
            "EMAIL_FROM": "LunchLineup <noreply@example.test>",
            "APP_ORIGIN": "https://app.example.test",
        }
        with patch.dict(os.environ, base, clear=True):
            with self.assertRaisesRegex(RuntimeError, "PLATFORM_ADMIN_DB_CONTEXT_SECRET"):
                delivery.validate_staff_invitation_outbox_config()

        base["PLATFORM_ADMIN_DB_CONTEXT_SECRET"] = "platform-capability"
        base["STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY"] = "not-a-key"
        with patch.dict(os.environ, base, clear=True):
            with self.assertRaisesRegex(RuntimeError, "exactly 32 bytes"):
                delivery.validate_staff_invitation_outbox_config()

        base["STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY"] = KEY.hex()
        base["PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY"] = KEY.hex()
        with patch.dict(os.environ, base, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be dedicated"):
                delivery.validate_staff_invitation_outbox_config()

        base["PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY"] = base64.urlsafe_b64encode(KEY).decode(
            "ascii"
        ).rstrip("=")
        with patch.dict(os.environ, base, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be dedicated"):
                delivery.validate_staff_invitation_outbox_config()

    def test_runtime_config_matches_schema_bounds_and_rejects_unsafe_relationships(self):
        configured = {
            "STAFF_INVITATION_MAX_ATTEMPTS": "2",
            "STAFF_INVITATION_LEASE_SECONDS": "120",
            "STAFF_INVITATION_SWEEP_BATCH_SIZE": "7",
            "STAFF_INVITATION_SWEEP_INTERVAL_SECONDS": "10",
            "STAFF_INVITATION_PROVIDER_TIMEOUT_SECONDS": "8",
            "STAFF_INVITATION_RETRY_BASE_SECONDS": "15",
            "STAFF_INVITATION_RETRY_MAX_SECONDS": "90",
            "STAFF_INVITATION_RETRY_JITTER_RATIO": "0.2",
            "STAFF_INVITATION_PROVIDER_FAILURE_THRESHOLD": "3",
            "STAFF_INVITATION_PROVIDER_HEALTH_WINDOW_SECONDS": "120",
            "STAFF_INVITATION_DIAGNOSTICS_COUNT_CAP": "50",
            "STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS": "30",
        }
        with patch.dict(os.environ, configured, clear=True):
            runtime = delivery.invitation_runtime_config()
        self.assertEqual(runtime.max_attempts, 2)
        self.assertEqual(runtime.sweep_batch_size, 7)
        self.assertEqual(runtime.sweep_max_staleness_seconds, 30)

        invalid = (
            {"STAFF_INVITATION_MAX_ATTEMPTS": "9"},
            {
                "STAFF_INVITATION_LEASE_SECONDS": "30",
                "STAFF_INVITATION_PROVIDER_TIMEOUT_SECONDS": "30",
            },
            {
                "STAFF_INVITATION_RETRY_BASE_SECONDS": "60",
                "STAFF_INVITATION_RETRY_MAX_SECONDS": "30",
            },
            {
                "STAFF_INVITATION_SWEEP_INTERVAL_SECONDS": "20",
                "STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS": "30",
            },
        )
        for overrides in invalid:
            with self.subTest(overrides=overrides), patch.dict(
                os.environ, overrides, clear=True
            ):
                with self.assertRaises(RuntimeError):
                    delivery.invitation_runtime_config()

    def test_enabled_delivery_requires_canonical_https_production_origin(self):
        base = {
            "STAFF_INVITATION_OUTBOX_ENABLED": "true",
            "DATABASE_URL": "postgresql://worker@example.test/lunchlineup",
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "platform-capability",
            "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY": KEY.hex(),
            "RESEND_API_KEY": "re_test_secret",
            "EMAIL_FROM": "LunchLineup <noreply@example.test>",
            "ENVIRONMENT": "production",
        }
        for origin in (
            "http://app.example.test",
            "https://user:secret@app.example.test",
            "https://app.example.test/path",
            "https://app.example.test?token=secret",
            "https://app.example.test#fragment",
            "https://app example.test",
            "https://app.example.test:not-a-port",
        ):
            with self.subTest(origin=origin), patch.dict(
                os.environ, {**base, "APP_ORIGIN": origin}, clear=True
            ):
                with self.assertRaisesRegex(RuntimeError, "APP_ORIGIN"):
                    delivery.validate_staff_invitation_outbox_config()

        with patch.dict(
            os.environ,
            {**base, "APP_ORIGIN": "https://app.example.test/"},
            clear=True,
        ):
            delivery.validate_staff_invitation_outbox_config()
            self.assertEqual(
                delivery.invitation_login_url(),
                "https://app.example.test/auth/login",
            )

    def test_delivery_is_disabled_by_default_and_disabled_config_has_no_secret_dependency(self):
        with patch.dict(os.environ, {}, clear=True):
            self.assertFalse(delivery.staff_invitation_outbox_enabled())
            delivery.validate_staff_invitation_outbox_config()

        with patch.dict(os.environ, {
            "ENVIRONMENT": "production",
            "STAFF_INVITATION_OUTBOX_ENABLED": "false",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "must be true in production"):
                delivery.validate_staff_invitation_outbox_config()

        with patch.dict(os.environ, {
            "STAFF_INVITATION_OUTBOX_ENABLED": "TRUE",
        }, clear=True):
            with self.assertRaisesRegex(RuntimeError, "exactly true or false"):
                delivery.staff_invitation_outbox_enabled()


class InvitationStoreTests(TestCase):
    def setUp(self):
        self.environment = patch.dict(os.environ, {
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "platform-capability",
        }, clear=False)
        self.environment.start()
        self.addCleanup(self.environment.stop)

    def test_claim_is_atomic_skip_locked_bounded_and_recovers_expired_leases(self):
        item = encrypted_item(attempts=2)
        row = (
            item.id,
            item.tenant_id,
            item.user_id,
            item.recipient_hash,
            item.purpose,
            item.encrypted_payload,
            item.encryption_nonce,
            item.encryption_tag,
            item.encryption_key_ref,
            item.payload_version,
            item.attempts,
            item.lease_owner,
        )
        cursor = QueryCursor([row])
        store = PostgresInvitationStore(
            "postgresql://worker@example.test/lunchlineup",
            worker_id="worker-1",
            now=lambda: datetime(2026, 7, 16, tzinfo=timezone.utc),
        )

        with patch.object(store, "_connect", return_value=QueryConnection(cursor)):
            claimed = store.claim_batch(5)

        claim_sql, claim_params = next(
            call for call in cursor.calls if 'RETURNING outbox."id"' in call[0]
        )
        normalized = " ".join(claim_sql.split())
        self.assertIn("FOR UPDATE OF outbox SKIP LOCKED", normalized)
        self.assertIn("outbox.\"status\" = 'SENDING'", normalized)
        self.assertIn('outbox."leaseExpiresAt" <= %s', normalized)
        self.assertIn('"attempts" = outbox."attempts" + 1', normalized)
        self.assertEqual(claim_params[3], 5)
        self.assertEqual(claimed[0].id, item.id)

        exhausted_sql, exhausted_params = next(
            call for call in cursor.calls
            if "CONFIGURED_ATTEMPT_LIMIT_REACHED" in call[0]
        )
        normalized_exhausted = " ".join(exhausted_sql.split())
        self.assertIn("\"status\" IN ('PENDING', 'FAILED')", normalized_exhausted)
        self.assertIn('"attempts" >= %s', normalized_exhausted)
        self.assertIn("FOR UPDATE SKIP LOCKED LIMIT 100", normalized_exhausted)
        self.assertEqual(exhausted_params[0], store.max_attempts)

    def test_global_claim_fails_closed_before_table_access_without_capability(self):
        cursor = QueryCursor([])
        store = PostgresInvitationStore("postgresql://worker@example.test/lunchlineup")

        with patch.dict(os.environ, {"PLATFORM_ADMIN_DB_CONTEXT_SECRET": ""}, clear=False), \
                patch.object(store, "_connect", return_value=QueryConnection(cursor)):
            with self.assertRaises(GlobalClaimCapabilityError):
                store.claim_batch(1)

        self.assertEqual(cursor.calls, [])

    def test_global_claim_verifies_database_capability_before_table_access(self):
        cursor = QueryCursor([], capability=False)
        store = PostgresInvitationStore("postgresql://worker@example.test/lunchlineup")

        with patch.object(store, "_connect", return_value=QueryConnection(cursor)):
            with self.assertRaises(GlobalClaimCapabilityError):
                store.claim_batch(1)

        self.assertEqual(len(cursor.calls), 2)
        self.assertIn("set_current_platform_admin", cursor.calls[0][0])
        self.assertIn("is_current_platform_admin", cursor.calls[1][0])

    def test_retry_uses_jittered_backoff_and_terminal_state_relies_on_erasure_trigger(self):
        item = encrypted_item(attempts=3)
        cursor = QueryCursor([])
        store = PostgresInvitationStore(
            "postgresql://worker@example.test/lunchlineup",
            retry_base_seconds=10,
            retry_max_seconds=100,
            retry_jitter_ratio=0.25,
            random_uniform=lambda low, high: high,
            now=lambda: datetime(2026, 7, 16, tzinfo=timezone.utc),
        )

        with patch.object(store, "_connect", return_value=QueryConnection(cursor)):
            store.mark_failed(item, "PROVIDER_RETRYABLE", False)

        update_sql, params = next(call for call in cursor.calls if 'SET "status" = %s' in call[0])
        self.assertEqual(params[0], "FAILED")
        self.assertEqual((params[1] - datetime(2026, 7, 16, tzinfo=timezone.utc)).total_seconds(), 50)

        cursor.calls.clear()
        with patch.object(store, "_connect", return_value=QueryConnection(cursor)):
            store.mark_failed(item, "PROVIDER_REJECTED", True)
        terminal_sql, params = next(call for call in cursor.calls if 'SET "status" = %s' in call[0])
        self.assertEqual(params[0], "DEAD_LETTERED")
        self.assertNotIn('"encryptedPayload" =', terminal_sql)
        self.assertNotIn('"encryptionNonce" =', terminal_sql)
        self.assertNotIn('"encryptionTag" =', terminal_sql)

    def test_provider_auth_configuration_failure_preserves_retryable_envelope(self):
        item = encrypted_item(attempts=1)
        cursor = QueryCursor([])
        store = PostgresInvitationStore(
            "postgresql://worker@example.test/lunchlineup",
            now=lambda: datetime(2026, 7, 16, tzinfo=timezone.utc),
        )

        with patch.object(store, "_connect", return_value=QueryConnection(cursor)):
            store.mark_failed(item, "PROVIDER_RETRYABLE", False)

        retry_sql, params = next(
            call for call in cursor.calls if 'SET "status" = %s' in call[0]
        )
        self.assertEqual(params[0], "FAILED")
        self.assertEqual(params[3], "PROVIDER_RETRYABLE")
        self.assertNotIn('"encryptedPayload" =', retry_sql)
        self.assertNotIn('"encryptionNonce" =', retry_sql)
        self.assertNotIn('"encryptionTag" =', retry_sql)
