"""Private source-only regression draft for actual client serialization.
Future destination: apps/worker/tests/test_billing_usage_client_contract.py.
No store/SQL/RLS/recovery/provider-acceptance proof is claimed.
"""
from __future__ import annotations

from dataclasses import replace
from datetime import datetime, timezone
from email.message import Message
from pathlib import Path
import sys
import unittest
from unittest.mock import patch
from urllib.error import HTTPError, URLError
from urllib.parse import parse_qs

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))
from src import billing_usage  # noqa: E402

API_BASE = "https://billing-client-fixture.invalid"
SYNTHETIC_SECRET = "fixture-secret-not-a-credential"


def event_a():
    return billing_usage.UsageEvent(
        id="usage-a", tenant_id="tenant-fixture",
        event_name="active_staff", stripe_customer_id="cus_fixture_a",
        quantity=14, identifier="ll_fixture_a",
        idempotency_key="stripe_usage_fixture_a",
        timestamp=datetime(2026, 1, 1, tzinfo=timezone.utc), attempts=1,
    )


class Response:
    def __init__(self, body=b'{"identifier":"ll_fixture_a"}'):
        self.body = body
        self.headers = {"Request-Id": "req_fixture"}
        self.read_limits = []
        self.closed = False

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        self.closed = True
        return False

    def read(self, limit):
        self.read_limits.append(limit)
        return self.body


class ClientContractTests(unittest.TestCase):
    def setUp(self):
        self.requests = []
        self.responses = []
        self.outcomes = []
        # Every test replaces the actual module's urlopen before constructing
        # or invoking its client. An unexpected extra call fails locally.
        self.patcher = patch.object(billing_usage, "urlopen", self.capture)
        self.patcher.start()
        self.addCleanup(self.patcher.stop)
        self.client = billing_usage.StripeMeterClient(
            secret_key=SYNTHETIC_SECRET, api_base=API_BASE + "/",
        )

    def capture(self, request, timeout):
        self.requests.append((request, timeout))
        if not self.outcomes:
            raise AssertionError("Unexpected additional local transport call")
        outcome = self.outcomes.pop(0)
        if isinstance(outcome, BaseException):
            raise outcome
        self.responses.append(outcome)
        return outcome

    def assert_first_request_a(self):
        self.assertEqual(len(self.requests), 1)
        request, timeout = self.requests[0]
        self.assertEqual(request.full_url, API_BASE + "/v1/billing/meter_events")
        self.assertEqual(request.get_method(), "POST")
        self.assertEqual(timeout, 20)
        headers = {key.lower(): value for key, value in request.header_items()}
        self.assertEqual(headers["authorization"], "Bearer " + SYNTHETIC_SECRET)
        self.assertEqual(headers["content-type"], "application/x-www-form-urlencoded")
        self.assertEqual(headers["idempotency-key"], "stripe_usage_fixture_a")
        self.assertEqual(headers["user-agent"], "LunchLineup-Worker/1.0")
        # Literal independent oracle: exactly five fields, no store-derived
        # expected values or serializer-generated expected body.
        self.assertEqual(parse_qs(request.data.decode("ascii"), strict_parsing=True, keep_blank_values=True), {
            "event_name": ["active_staff"],
            "payload[stripe_customer_id]": ["cus_fixture_a"],
            "payload[value]": ["14"],
            "identifier": ["ll_fixture_a"],
            "timestamp": ["1767225600"],
        })

    def test_literal_request_and_bounded_response_read(self):
        response = Response()
        self.outcomes = [response]
        result = self.client.send(event_a())
        self.assert_first_request_a()
        self.assertEqual(result.object_id, "ll_fixture_a")
        self.assertEqual(result.request_id, "req_fixture")
        self.assertEqual(response.read_limits, [1_048_576])
        self.assertTrue(response.closed)
        self.assertEqual(self.outcomes, [])

    def test_supplied_event_retry_keeps_exact_bytes_after_timeout(self):
        response = Response()
        self.outcomes = [TimeoutError("private-timeout-sentinel"), response]
        with self.assertRaisesRegex(
            billing_usage.RetryableBillingError, "^Stripe meter event request failed$",
        ):
            self.client.send(event_a())
        self.assert_first_request_a()
        first_request, first_timeout = self.requests[0]
        self.client.send(replace(event_a(), attempts=2))
        self.assertEqual(len(self.requests), 2)
        retry_request, retry_timeout = self.requests[1]
        self.assertEqual(retry_request.data, first_request.data)
        self.assertEqual(retry_request.header_items(), first_request.header_items())
        self.assertEqual(retry_request.full_url, first_request.full_url)
        self.assertEqual(retry_timeout, first_timeout)
        self.assertEqual(response.read_limits, [1_048_576])
        self.assertTrue(response.closed)

    def test_changed_supplied_snapshot_is_a_sensitive_control(self):
        self.outcomes = [Response(), Response()]
        self.client.send(event_a())
        self.assert_first_request_a()
        self.client.send(replace(
            event_a(), event_name="active_staff_v2",
            stripe_customer_id="cus_fixture_b", quantity=29,
        ))
        self.assertEqual(len(self.requests), 2)
        changed = self.requests[1][0]
        self.assertNotEqual(changed.data, self.requests[0][0].data)
        self.assertEqual(parse_qs(changed.data.decode("ascii"), keep_blank_values=True), {
            "event_name": ["active_staff_v2"],
            "payload[stripe_customer_id]": ["cus_fixture_b"],
            "payload[value]": ["29"],
            "identifier": ["ll_fixture_a"],
            "timestamp": ["1767225600"],
        })

    def test_supplied_replay_identity_changes_only_identifier_and_key(self):
        self.outcomes = [Response(), Response()]
        self.client.send(event_a())
        self.assert_first_request_a()
        replay = replace(event_a(), id="usage-replay", identifier="ll_fixture_replay",
                         idempotency_key="stripe_usage_fixture_replay", attempts=1)
        self.client.send(replay)
        first = parse_qs(self.requests[0][0].data.decode("ascii"), keep_blank_values=True)
        second = parse_qs(self.requests[1][0].data.decode("ascii"), keep_blank_values=True)
        self.assertEqual(second.pop("identifier"), ["ll_fixture_replay"])
        first.pop("identifier")
        self.assertEqual(second, first)
        headers = {key.lower(): value for key, value in self.requests[1][0].header_items()}
        self.assertEqual(headers["idempotency-key"], "stripe_usage_fixture_replay")
        self.assertEqual(len(self.requests), 2)

    def test_transport_errors_translate_without_private_text(self):
        for error in (TimeoutError("private-timeout"), URLError("private-url"),
                      OSError("private-os")):
            with self.subTest(error=type(error).__name__):
                self.outcomes = [error]
                before = len(self.requests)
                with self.assertRaises(billing_usage.RetryableBillingError) as caught:
                    self.client.send(event_a())
                self.assertEqual(str(caught.exception), "Stripe meter event request failed")
                self.assertIs(caught.exception.__cause__, error)
                self.assertEqual(len(self.requests), before + 1)
                self.assertEqual(self.outcomes, [])

    def test_http_status_and_explicit_retry_header_translation(self):
        cases = [(status, None, True) for status in (408, 409, 429, 500, 502, 503, 504)]
        cases += [(400, None, False), (401, None, False), (400, "true", True),
                  (400, "false", False), (400, "TRUE", False)]
        for status, retry_header, retryable in cases:
            with self.subTest(status=status, retry_header=retry_header):
                headers = Message()
                if retry_header is not None:
                    headers["Stripe-Should-Retry"] = retry_header
                error = HTTPError(API_BASE, status, "private-http-text", headers, None)
                self.addCleanup(error.close)
                self.outcomes = [error]
                before = len(self.requests)
                expected = (billing_usage.RetryableBillingError if retryable
                            else billing_usage.NonRetryableBillingError)
                with self.assertRaises(expected) as caught:
                    self.client.send(event_a())
                self.assertEqual(str(caught.exception),
                                 f"Stripe meter event request failed with HTTP {status}")
                self.assertIs(caught.exception.__cause__, error)
                self.assertEqual(len(self.requests), before + 1)

    def test_invalid_response_translation_and_context_closure(self):
        for body in (b"not-json", b"\xff"):
            with self.subTest(body=body):
                response = Response(body)
                self.outcomes = [response]
                before = len(self.requests)
                with self.assertRaises(billing_usage.RetryableBillingError) as caught:
                    self.client.send(event_a())
                self.assertEqual(str(caught.exception),
                                 "Stripe meter event returned an invalid response")
                self.assertEqual(len(self.requests), before + 1)
                self.assertEqual(response.read_limits, [1_048_576])
                self.assertTrue(response.closed)
