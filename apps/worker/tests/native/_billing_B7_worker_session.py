"""SOURCE DRAFT: B7's two worker phases in one owned, non-resumable session.

Import alone opens no database. This module has no CLI or ordinary test entry.
A future admitted controller must own phase paths, run the actual API child,
observe its successful exit, validate exact result/source hashes, settle all
resources and record terminal cleanup. That controller is NOT implemented.
JSON, an exit-code argument, this helper, or a transport mock is not admission,
process-settlement proof, network isolation, provider evidence or release proof.
"""
from __future__ import annotations

from contextlib import ExitStack
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import re
import sys
import time
from unittest.mock import patch

import _billing_native_target as native
from _billing_native_target import (
    API_BASE, BASE_ENV, Fixture, NoEgressTransport, Target, WORKER_SHA256,
    instant, require, utc_naive,
)

TARGET_HELPER_SHA256 = "ea2d53d1564991d048694d4b49b2b8fb61cb587af8d1c436b2d6acdd421a4f23"
SERVICE_SHA256 = "848a138658063007b237c7c48514523deb9190fcb26d63e7d38f1e397ab907fe"
TENANT_SHA256 = "0a4a9040cf2b32de30552d2725c949c00b44816b51d83e230670e6f409ec37d1"
START = "2026-07-09T19:00:00.000Z"
END = "2026-07-09T20:00:00.000Z"
FIRST_NOW = "2026-07-09T19:30:10.000Z"
API_NOW = "2026-07-09T19:31:00.000Z"
EARLY_NOW = "2026-07-09T19:31:10.000Z"
BACKOFF = "2026-07-09T19:36:00.000Z"
RETRY_NOW = "2026-07-09T19:36:01.000Z"
EPOCH_START = 1783623600  # Literal19:00 UTC, not a production identity helper.
STABLE_FIELDS = (
    "id", "tenantId", "metric", "periodStart", "periodEnd", "quantity",
    "eventName", "stripeCustomerId", "createdAt",
)


def wire_value(value):
    """Normalize actual TIMESTAMP(3) observations from this verified UTC target."""
    if isinstance(value, datetime):
        require(value.microsecond % 1000 == 0, "Non-millisecond native timestamp")
        if value.tzinfo is None:
            value = value.replace(tzinfo=timezone.utc)
        return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")
    if isinstance(value, dict):
        require(all(isinstance(key, str) for key in value), "Non-string native JSON key")
        return {key: wire_value(item) for key, item in value.items()}
    if isinstance(value, list):
        return [wire_value(item) for item in value]
    require(value is None or isinstance(value, (str, int, float, bool)),
            "Unexpected native row/JSON value")
    return value


def bounded_json_bytes(value):
    body = (json.dumps(wire_value(value), ensure_ascii=True, allow_nan=False,
                       sort_keys=True, separators=(",", ":")) + "\n").encode("ascii")
    require(0 < len(body) <= 65536, "B7 phase JSON exceeds bound")
    return body


def unique_object(pairs):
    result = {}
    for key, value in pairs:
        require(key not in result, "Duplicate B7 result key")
        result[key] = value
    return result


def actual_request(transport, index, row):
    """Literal A oracle, then actual captured bytes; never reconstruct a UsageEvent."""
    request = transport.captures[index]
    require(request["url"] == API_BASE + "/v1/billing/meter_events"
            and request["method"] == "POST"
            and request["content_type"] == "application/x-www-form-urlencoded"
            and request["agent"] == "LunchLineup-Worker/1.0"
            and request["timeout"] == 20
            and request["key"] == row["idempotencyKey"],
            "B7 actual client endpoint/header/identity contract differs")
    require(transport.decoded(index) == {
        "event_name": ["fixture_staff_A"],
        "payload[stripe_customer_id]": ["fixture_customer_A_" + row["tenantId"]],
        "payload[value]": ["3"],
        "identifier": [row["identifier"]],
        "timestamp": [str(EPOCH_START)],
    }, "B7 actual client did not emit literal A payload and old timestamp")
    return {
        "bodyAscii": request["body"].decode("ascii"),
        "url": request["url"], "method": request["method"],
        "contentType": request["content_type"], "idempotencyKey": request["key"],
        "userAgent": request["agent"], "timeoutSeconds": request["timeout"],
    }


class B7WorkerSession:
    """Single process lifetime; cannot reattach a new session to retained rows."""

    def __init__(self, target_receipt):
        self.receipt_path = target_receipt
        self.phase = "NEW"
        self.stack = None
        self.target = None
        self.fixture = None
        self.started = None
        self.cleanup_verified = False

    def __enter__(self):
        require(self.phase == "NEW", "B7 session is not reusable")
        self.phase = "SETTING_UP"
        self.started = time.monotonic()
        self.stack = ExitStack()
        try:
            # Future controller must verify all loaded fixture/helper bodies
            # BEFORE importing them; this additional readback does not undo an
            # untrusted import or qualify dependency/install provenance.
            require(hashlib.sha256(Path(native.__file__).read_bytes()).hexdigest()
                    == TARGET_HELPER_SHA256, "Wrong selected native helper")
            # Restore TZ after restoring the environment, including failed setup.
            self.stack.callback(time.tzset)
            env = dict(BASE_ENV)
            env["STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS"] = "3600"
            self.stack.enter_context(patch.dict(os.environ, env, clear=True))
            time.tzset()
            self.target = Target(self.receipt_path)
            os.environ["PLATFORM_ADMIN_DB_CONTEXT_SECRET"] = self.target.receipt["platformCapability"]
            self.target.verify()  # Includes real empty DB/role/RLS/full ledger/routine checks.
            self.loaded_name, self.worker = self.target.load_worker()
            self.stack.callback(sys.modules.pop, self.loaded_name, None)
            self.fixture = Fixture(self.target, self.worker)
            self.stack.enter_context(self.fixture.clock.patch)
            self.stack.callback(self._cleanup_owned)
            self.store = self.fixture.store()
            self.phase = "READY"
            return self
        except BaseException:
            self.phase = "FAILED"
            self.stack.close()
            raise

    def __exit__(self, exc_type, exc, traceback):
        # A failed body never produces success by cleanup alone. Failed cleanup
        # propagates; the future controller must preserve the original failure
        # and cleanup failure, retain evidence and prohibit automatic retry.
        try:
            self.stack.__exit__(exc_type, exc, traceback)
        finally:
            self.phase = "CLOSED"
        return False

    def _live(self, expected):
        try:
            require(self.phase == expected and self.target.verified and not self.target.poisoned,
                    "B7 phase ordering/target ownership failed")
            require(time.monotonic() - self.started < 120,
                    "B7 publication observation deadline exceeded")
            require(os.environ.get("STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS") == "3600",
                    "B7 interval changed after initial preparation")
            require(instant(self.target.receipt["expiresAtUtc"]) > datetime.now(timezone.utc),
                    "B7 receipt expired")
            require(hashlib.sha256(self.target.source_path.read_bytes()).hexdigest()
                    == WORKER_SHA256, "B7 worker source changed during session")

        except BaseException:
            self.phase = "FAILED"
            raise

    def _cleanup_owned(self):
        try:
            self.fixture.cleanup()  # Exact IDs registered before seed SQL.
            with self.fixture.context() as cursor:
                for tenant in self.fixture.tenants:
                    for table, column in (('"StripeUsageEvent"', '"tenantId"'),
                                          ('"User"', '"tenantId"'), ('"Tenant"', '"id"')):
                        cursor.execute("SELECT COUNT(*) FROM " + table + " WHERE " + column + "=%s",
                                       (tenant,))
                        require(cursor.fetchone() == (0,), "B7 exact owned row cleanup not empty")
            self.cleanup_verified = True
            # This verifies rows through fresh, context-owned connections. It does
            # not prove native TCP/backend/executor termination or cleanup of an
            # abruptly killed process. Those owner terminal readbacks remain gates.

        except BaseException:
            self.cleanup_verified = False
            self.target.poisoned = True
            raise

    def start(self):
        """Actual preparation/claim/send/mark_sent; return bounded handoff bytes."""
        self._live("READY")
        self.phase = "STARTING"
        try:
            self.fixture.clock.at(FIRST_NOW)
            self.tenant = self.fixture.seed(
                tenant_id="fixture_" + self.target.receipt["ownerJobId"] + "_B7_one",
            )
            transport = NoEgressTransport(["success"])
            dispatched = self.fixture.dispatch(self.tenant, self.store, transport)
            require(dispatched.get("sent") is True, "B7 initial actual dispatch did not send")
            self.initial = wire_value(self.fixture.one(self.tenant))
            row = self.initial
            require((row["metric"], row["quantity"], row["eventName"], row["stripeCustomerId"])
                    == ("ACTIVE_STAFF", 3, "fixture_staff_A", "fixture_customer_A_" + self.tenant)
                    and row["periodStart"] == START and row["periodEnd"] == END
                    and row["status"] == "SENT" and row["attempts"] == 1
                    and row["submittedAt"] == FIRST_NOW and row["sentAt"] == FIRST_NOW
                    and row["stripeObjectId"] == "synthetic-result"
                    and row["stripeRequestId"] == "synthetic-request"
                    and row["lastError"] is None, "B7 literal persisted A contract differs")
            require(len(transport.captures) == 1 and transport.outcomes == [],
                    "B7 initial actual client count differs")
            self.first_request = actual_request(transport, 0, row)
            self.first_body = transport.captures[0]["body"]
            with self.target.connect() as connection:
                with connection.cursor() as cursor:
                    cursor.execute("SELECT current_database(),current_user")
                    require(cursor.fetchone() == (self.target.receipt["database"],
                                                  self.target.receipt["role"]),
                            "B7 actual handoff database identity differs")
                # These are the actual Psycopg connection target properties,
                # not the API URL or credentials copied into phase output.
                identity = {"database": connection.info.dbname, "role": connection.info.user,
                            "host": connection.info.host, "port": connection.info.port}
            require(identity["database"] == "lunchlineup_test"
                    and identity["role"] == "lunchlineup_ci_app"
                    and identity["host"] == "127.0.0.1"
                    and str(identity["port"]) == str(self.target.receipt["port"]),
                    "B7 actual endpoint differs from admitted disposable target")
            handoff = {
                "kind": "billing-B7-worker-sent-A", "ownerJobId": self.target.receipt["ownerJobId"],
                "intervalSeconds": 3600, "tenantId": self.tenant, "usageEventId": row["id"],
                "databaseIdentity": identity, "initialRow": row,
                "firstCapture": self.first_request, "workerSourceSha256": WORKER_SHA256,
                "helperSourceSha256": TARGET_HELPER_SHA256, "actualProvider": False,
                "controllerBinding": {
                    key: self.target.controller[key] for key in
                    ("ciRunId", "ciSourceSha", "preflightPath", "preflightSha256")
                },
            }
            self.phase = "SENT_A"
            self._live("SENT_A")
            return bounded_json_bytes(handoff)
        except BaseException:
            self.phase = "FAILED"
            raise

    def finish(self, api_result_bytes, *, observed_api_returncode):
        """Verify API's real row, early B drift and actual frozen-A resend.

        The exit-code argument is only an ordering precondition. The unfinished
        controller must observe the actual owned child exit and settlement; a
        supplied zero or result file cannot attest that fact or admit execution.
        """
        self._live("SENT_A")
        self.phase = "FINISHING"
        try:
            require(type(observed_api_returncode) is int and observed_api_returncode == 0,
                    "B7 API child did not exit successfully")
            require(isinstance(api_result_bytes, bytes) and 0 < len(api_result_bytes) <= 65536,
                    "B7 API result bytes exceed bound")
            result = json.loads(api_result_bytes, object_pairs_hook=unique_object)
            require(isinstance(result, dict), "B7 API result is not an object")
            job = self.target.receipt["ownerJobId"]
            require(result.get("kind") == "billing-B7-api-rotated-once"
                    and result.get("ownerJobId") == job and result.get("tenantId") == self.tenant
                    and result.get("usageEventId") == self.initial["id"]
                    and result.get("intervalSeconds") == 3600
                    and result.get("eventId") == "evt_fixture_B7_" + job
                    and result.get("handlerSourceSha256") == SERVICE_SHA256
                    and result.get("tenantSourceSha256") == TENANT_SHA256
                    and result.get("apiNow") == API_NOW
                    and result.get("first") == {"matched": 1, "transitioned": 1}
                    and result.get("duplicate") == {"matched": 1, "transitioned": 0}
                    and result.get("sdkCalls") == 2 and result.get("retrievalCalls") == 2
                    and result.get("actualProvider") is False
                    and result.get("controllerBinding") == {
                        key: self.target.controller[key] for key in
                        ("ciRunId", "ciSourceSha", "preflightPath", "preflightSha256")
                    },
                    "B7 API result job/source/controller/phase/count binding failed")
            rotated = wire_value(self.fixture.one(self.tenant))
            require(rotated == result.get("rotatedRow"), "B7 result differs from actual committed API row")
            for key in STABLE_FIELDS:
                require(rotated[key] == self.initial[key], "B7 API changed frozen logical payload")
            require(rotated["status"] == "FAILED" and rotated["attempts"] == 1
                    and rotated["nextAttemptAt"] == BACKOFF
                    and rotated["submittedAt"] == FIRST_NOW
                    and rotated["sentAt"] is None and rotated["stripeObjectId"] is None
                    and rotated["stripeRequestId"] is None,
                    "B7 actual rotated row/backoff/result markers differ")
            require(re.fullmatch(r"ll_async_[a-f0-9]{64}", rotated["identifier"])
                    and re.fullmatch(r"stripe_usage_async_[a-f0-9]{64}", rotated["idempotencyKey"])
                    and rotated["identifier"] != self.initial["identifier"]
                    and rotated["idempotencyKey"] != self.initial["idempotencyKey"],
                    "B7 actual transport identities did not rotate")
            metadata = rotated["metadata"]
            require(isinstance(metadata, dict)
                    and metadata.get("logicalUsageIdentity") == self.initial["identifier"]
                    and metadata.get("stripeAsyncError") == {
                        "eventId": "evt_fixture_B7_" + job,
                        "eventType": "v1.billing.meter.error_report_triggered",
                        "code": "timestamp_in_future", "disposition": "explicit_bounded_retry",
                        "rejectedIdentifier": self.initial["identifier"],
                        "rejectedIdempotencyKey": self.initial["idempotencyKey"],
                        "retryIdentifier": rotated["identifier"],
                        "retryIdempotencyKey": rotated["idempotencyKey"], "receivedAt": API_NOW,
                    }, "B7 actual async provenance differs")
            self.fixture.clock.at(EARLY_NOW)
            self.fixture.drift(self.tenant, {"count", "customer", "name"})
            with self.fixture.context(self.tenant) as cursor:
                cursor.execute('SELECT COUNT(*) FROM "User" WHERE "tenantId"=%s AND "deletedAt" IS NULL',
                               (self.tenant,))
                require(cursor.fetchone() == (4,), "B7 count B drift did not commit")
                cursor.execute('SELECT "stripeCustomerId" FROM "Tenant" WHERE "id"=%s', (self.tenant,))
                require(cursor.fetchone() == ("fixture_customer_B_" + self.tenant,),
                        "B7 customer B drift did not commit")
            require(os.environ["STRIPE_METER_EVENT_NAME"] == "fixture_staff_B",
                    "B7 name B drift missing")
            early_transport = NoEgressTransport([])
            early = self.fixture.dispatch(self.tenant, self.store, early_transport)
            require(early == {"skipped": True, "tenant_id": self.tenant}
                    and early_transport.captures == [],
                    "B7 early actual preparation/claim bypassed API backoff")
            require(wire_value(self.fixture.one(self.tenant)) == rotated,
                    "B7 early actual preparation resampled frozen A or changed row")
            self.fixture.clock.at(RETRY_NOW)
            transport = NoEgressTransport(["success"])
            sent_result = self.fixture.dispatch(self.tenant, self.store, transport)
            require(sent_result.get("sent") is True and sent_result.get("attempts") == 2,
                    "B7 due actual dispatch did not complete second attempt")
            sent = wire_value(self.fixture.one(self.tenant))
            for key in STABLE_FIELDS + ("identifier", "idempotencyKey", "metadata"):
                require(sent[key] == rotated[key], "B7 resend changed frozen A or async identity/provenance")
            require(sent["status"] == "SENT" and sent["attempts"] == 2
                    and sent["submittedAt"] == RETRY_NOW and sent["sentAt"] == RETRY_NOW
                    and sent["stripeObjectId"] == "synthetic-result"
                    and sent["stripeRequestId"] == "synthetic-request" and sent["lastError"] is None,
                    "B7 resend durable completion differs")
            require(len(transport.captures) == 1 and transport.outcomes == [],
                    "B7 resend actual client count differs")
            retry_request = actual_request(transport, 0, sent)
            # Old/new identifiers are transport-owned safe ASCII strings here.
            # Manual decoded oracle above establishes A; this byte comparison
            # additionally requires that only the rotated identifier changed.
            original_marker = ("identifier=" + self.initial["identifier"]).encode("ascii")
            rotated_marker = ("identifier=" + rotated["identifier"]).encode("ascii")
            require(self.first_body.count(original_marker) == 1
                    and transport.captures[0]["body"] == self.first_body.replace(original_marker, rotated_marker, 1)
                    and retry_request["idempotencyKey"] != self.first_request["idempotencyKey"],
                    "B7 raw resend changed more than transport identity")
            self.phase = "RESENT_A"
            self._live("RESENT_A")
            return bounded_json_bytes({
                "kind": "billing-B7-worker-resent-A", "ownerJobId": job,
                "tenantId": self.tenant, "usageEventId": sent["id"], "intervalSeconds": 3600,
                "firstRow": self.initial, "rotatedRow": rotated, "sentRow": sent,
                "firstCapture": self.first_request, "retryCapture": retry_request,
                "workerSourceSha256": WORKER_SHA256, "helperSourceSha256": TARGET_HELPER_SHA256,
                "apiResultSha256": hashlib.sha256(api_result_bytes).hexdigest(),
                "workerClientCalls": 2, "earlyClientCalls": 0, "apiProcessReturncode": observed_api_returncode,
                "actualProvider": False, "cleanupVerified": False,
                "terminalReadbacksRequired": True,
            })
        except BaseException:
            self.phase = "FAILED"
            raise
