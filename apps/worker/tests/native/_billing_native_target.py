"""Owner-gated native billing fixture support. Import alone performs no DB I/O.

Native fixture source: no native execution, authorization or target attestation.
The infrastructure owner must independently admit an isolated job and issue the
receipt after clearing incident/runtime holds. This module cannot prove backing
storage isolation, quota enforcement, provider behavior, or launch readiness.
"""
from __future__ import annotations

import asyncio
from contextlib import contextmanager
from datetime import datetime, timezone
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import re
import stat
import sys
import time
from unittest.mock import patch
from urllib.error import HTTPError
from urllib.parse import parse_qs
import uuid

WORKER_SHA256 = "778283496621bf4694c7062f3ad6954b9aa5ac3243403c67ee084f6bcddc9729"
SCHEMA_SHA256 = "08a4febaeffb80bd04b36b78bfd96881f14df0bd7d0c84b70c672a3ccb1ad20d"
FUNCTIONS = {
    "public.set_current_tenant(text)",
    "public.get_current_tenant()",
    "public.set_current_platform_admin(boolean,text)",
    "public.is_current_platform_admin()",
}
ROW_COLUMNS = (
    "id", "tenantId", "metric", "periodStart", "periodEnd", "quantity",
    "eventName", "stripeCustomerId", "identifier", "idempotencyKey", "status",
    "attempts", "nextAttemptAt", "submittedAt", "sentAt", "stripeObjectId",
    "stripeRequestId", "lastError", "metadata", "createdAt", "updatedAt",
)
PAYLOAD_COLUMNS = (
    "id", "tenantId", "metric", "periodStart", "periodEnd", "quantity",
    "eventName", "stripeCustomerId", "identifier", "idempotencyKey", "metadata",
    "createdAt",
)
BASE_ENV = {
    "TZ": "UTC",
    "STRIPE_METERED_USAGE_ENABLED": "true",
    "STRIPE_METER_EVENT_NAME": "fixture_staff_A",
    "STRIPE_METER_AGGREGATION": "last",
    "STRIPE_USAGE_SNAPSHOT_INTERVAL_SECONDS": "300",
    "STRIPE_USAGE_MAX_ATTEMPTS": "5",
    "STRIPE_USAGE_CLAIM_LEASE_SECONDS": "300",
    "STRIPE_USAGE_SWEEP_BATCH_SIZE": "2",
    "STRIPE_USAGE_DEAD_LETTER_REPLAY_ENABLED": "false",
}
API_BASE = "https://billing-fixture.invalid"
EPOCH_A = 1783625400  # Literal 2026-07-09T19:30:00Z; not production identity helper.


def instant(value):
    return datetime.fromisoformat(value.replace("Z", "+00:00"))


def utc_naive(value):
    return value.astimezone(timezone.utc).replace(tzinfo=None)


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def bounded_private_json_bytes(path):
    # Actual protected metadata only: not admission or resource ownership proof.
    fd = os.open(Path(path), os.O_RDONLY | os.O_NOFOLLOW | os.O_NONBLOCK)
    try:
        info = os.fstat(fd)
        require(stat.S_ISREG(info.st_mode) and info.st_nlink == 1,
                "Fixture receipt must be regular and single-link")
        require(info.st_uid == os.geteuid() and info.st_mode & 0o077 == 0,
                "Fixture receipt must be owner-private")
        require(0 < info.st_size <= 65536, "Fixture receipt exceeds size bound")
        chunks, size = [], 0
        while size <= 65536:
            part = os.read(fd, min(8192, 65537 - size))
            if not part:
                break
            size += len(part)
            chunks.append(part)
        after = os.fstat(fd)
        require(size == info.st_size and size <= 65536
                and (info.st_dev, info.st_ino, info.st_size, info.st_mtime_ns, info.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_mtime_ns, after.st_ctime_ns),
                "Fixture receipt changed during bounded read")
        body = b"".join(chunks)
        def unique(pairs):
            result = {}
            for key, value in pairs:
                require(key not in result, "Duplicate fixture receipt key")
                result[key] = value
            return result
        def invalid_constant(value):
            raise RuntimeError("Non-finite fixture receipt number")
        result = json.loads(body, object_pairs_hook=unique, parse_constant=invalid_constant)
        require(isinstance(result, dict), "Fixture receipt must be an object")
        return body
    finally:
        os.close(fd)


def bounded_private_json(path):
    return json.loads(bounded_private_json_bytes(path))


def approved_controller_binding(receipt):
    # Bind the actual existing-controller pre-seed receipt. A self-consistent
    # JSON/file/hash still cannot prove the live job, container/port/backing,
    # candidate approval or caller authority; the owner lease must do that.
    binding = receipt.get("controllerBinding")
    require(isinstance(binding, dict) and set(binding) == {
        "ciRunId", "ciSourceSha", "preflightPath", "preflightSha256",
    }, "Exact existing-controller binding required")
    run = binding["ciRunId"]
    source_sha = binding["ciSourceSha"]
    require(isinstance(run, str)
            and re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._-]{0,159}", run),
            "Invalid controller CI_RUN_ID")
    require(isinstance(source_sha, str) and re.fullmatch(r"[a-f0-9]{40}", source_sha),
            "Invalid exact controller candidate SHA")
    workspace = "/var/lib/custom-ci/workspaces/" + run
    temporary = "/var/lib/custom-ci/runs/" + run + "/tmp/job-tmp"
    build = temporary + "/lunchlineup-source-" + run + "/build"
    store = temporary + "/lunchlineup-integration-containers-" + run
    expected_path = workspace + "/.release/internal-ci/" + source_sha + "/integration-target.json"
    require(binding["preflightPath"] == expected_path
            and Path(expected_path).resolve(strict=True) == Path(expected_path),
            "Preflight is not the exact canonical approved controller receipt")
    require(isinstance(binding["preflightSha256"], str)
            and re.fullmatch(r"[a-f0-9]{64}", binding["preflightSha256"]),
            "Invalid controller preflight hash")
    body = bounded_private_json_bytes(expected_path)
    require(hashlib.sha256(body).hexdigest() == binding["preflightSha256"],
            "Actual controller preflight bytes differ")
    prefix = "lunchlineup-integration-" + re.sub(r"[^a-zA-Z0-9]", "", run)
    expected = {
        "runId": run, "sourceSha": source_sha, "workspace": workspace,
        "temporaryRoot": temporary, "mutationRole": "lunchlineup_ci_app",
        "dataTargetEnvironment": "disposable", "database": "lunchlineup_test",
        "store": store, "containers": [prefix + "-" + item
                                     for item in ("postgres", "redis", "rabbitmq")],
    }
    require(json.loads(body) == expected, "Actual pre-seed integration receipt differs")
    require(receipt.get("database") == "lunchlineup_test"
            and receipt.get("role") == "lunchlineup_ci_app",
            "Only the existing approved integration database/mutation role is allowed")
    return {**binding, "workspace": workspace, "runnerTemp": temporary,
            "buildRoot": build, "store": store, "postgresContainer": prefix + "-postgres"}


class Target:
    def __init__(self, receipt_path):
        receipt = bounded_private_json(receipt_path)
        require(receipt.get("kind") == "lunchlineup-disposable-billing-target",
                "Wrong fixture receipt kind")
        require(type(receipt.get("schemaVersion")) is int and receipt["schemaVersion"] == 2,
                "Unsupported fixture receipt; old standalone-target v1 is not admitted")
        require(receipt.get("runtimeCleared") is True,
                "Fixture receipt does not record runtime clearance")
        require(receipt.get("cleanupOwnership") == "exact-controller-job-fixture-rows",
                "Fixture cleanup ownership missing")
        require(re.fullmatch(r"[a-f0-9]{32}", receipt.get("ownerJobId", "")),
                "Fixture job identity invalid")
        expires = instant(receipt.get("expiresAtUtc", ""))
        require(expires.tzinfo is not None and expires > datetime.now(timezone.utc),
                "Fixture receipt expired")
        self.controller = approved_controller_binding(receipt)
        # Worker/source imports occur only after explicit receipt and exact pins.
        self.source_path = Path(receipt["workerSourcePath"]).resolve(strict=True)
        schema_path = Path(receipt["schemaSourcePath"]).resolve(strict=True)
        require(self.source_path == Path(self.controller["buildRoot"]) / "apps/worker/src/billing_usage.py"
                and schema_path == Path(self.controller["buildRoot"]) / "packages/db/prisma/schema.prisma"
                and self.source_path.is_file() and schema_path.is_file(),
                "Fixture source must be the exact approved controller build clone")
        require(receipt.get("workerSourceSha256") == WORKER_SHA256,
                "Unreviewed worker source pin")
        require(hashlib.sha256(self.source_path.read_bytes()).hexdigest() == WORKER_SHA256,
                "Loaded worker body differs from selected proposal")
        require(receipt.get("schemaSourceSha256") == SCHEMA_SHA256,
                "Unreviewed schema source pin")
        require(hashlib.sha256(schema_path.read_bytes()).hexdigest() == SCHEMA_SHA256,
                "Schema source differs from reviewed source")
        require(isinstance(receipt.get("platformCapability"), str)
                and 32 <= len(receipt["platformCapability"]) <= 4096,
                "Test-only platform capability missing")
        require(isinstance(receipt.get("routineSha256"), dict)
                and set(receipt["routineSha256"]) == FUNCTIONS,
                "All actual context routine pins required")
        migrations = receipt.get("rawMigrationReceipts")
        require(isinstance(migrations, list) and len(migrations) > 0,
                "Complete owner-reviewed migration inventory required")
        require(all(isinstance(row, dict)
                    and set(row) == {"path", "sha256", "bytes", "phase",
                                     "execution_mode", "source_sha"}
                    for row in migrations), "Invalid migration receipt rows")
        require(len({row["path"] for row in migrations}) == len(migrations),
                "Duplicate migration receipt")
        # Loading Psycopg is a future native action, not performed during drafting.
        import psycopg
        from psycopg.conninfo import conninfo_to_dict, make_conninfo
        params = conninfo_to_dict(receipt["dsn"])
        require(isinstance(params.get("password"), str) and params["password"],
                "Explicit test-only database password required")
        require(set(params) <= {"host", "port", "dbname", "user", "password", "sslmode"},
                "Fixture DSN may not supply services/options/extra endpoints")
        require(params.get("host") == "127.0.0.1",
                "Fixture requires an owner-issued loopback PostgreSQL target")
        require(params.get("dbname") == "lunchlineup_test"
                and receipt.get("database") == "lunchlineup_test",
                "Wrong approved controller integration database")
        require(params.get("user") == "lunchlineup_ci_app"
                and receipt.get("role") == "lunchlineup_ci_app",
                "Wrong approved restricted controller mutation role")
        require(str(params.get("port", "")) == str(receipt.get("port", ""))
                and str(receipt.get("port", "")).isdigit()
                and 1 <= int(receipt["port"]) <= 65535,
                "Fixture port mismatch")
        # Every real store connection uses these bounded session options.
        self.dsn = make_conninfo(
            **params, connect_timeout=5,
            application_name="ll-billing-fixture-" + receipt["ownerJobId"],
            options="-c timezone=UTC -c statement_timeout=10000 "
                    "-c lock_timeout=5000 -c idle_in_transaction_session_timeout=10000 "
                    "-c search_path=public,pg_catalog",
        )
        self.receipt = receipt
        self.driver = psycopg
        self.verified = False
        self.poisoned = False

    def connect(self):
        require(self.verified and not self.poisoned, "Fixture target not verified or poisoned")
        return self.driver.connect(self.dsn)

    def verify(self):
        require(not self.poisoned, "Fixture target poisoned after cleanup failure")
        # Read-only target checks precede every fixture mutation.
        with patch.dict(os.environ, {"TZ": "UTC"}, clear=True), \
                self.driver.connect(self.dsn) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT current_database(), current_user, current_setting('TimeZone'), "
                    "rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user"
                )
                row = cursor.fetchone()
                require(row is not None and row[:3] ==
                        (self.receipt["database"], self.receipt["role"], "UTC")
                        and row[3:] == (False, False),
                        "Fixture identity/timezone/runtime privilege mismatch")
                cursor.execute(
                    "SELECT relname, relrowsecurity, relforcerowsecurity "
                    "FROM pg_class WHERE oid IN "
                    "('public.\"Tenant\"'::regclass,'public.\"User\"'::regclass,"
                    "'public.\"StripeUsageEvent\"'::regclass)"
                )
                flags = {name: (enabled, forced) for name, enabled, forced in cursor.fetchall()}
                require(flags == {"Tenant": (True, True), "User": (True, True),
                                  "StripeUsageEvent": (True, True)},
                        "Actual FORCE RLS required on all fixture tables")
                for signature, expected in self.receipt["routineSha256"].items():
                    require(re.fullmatch(r"[a-f0-9]{64}", expected) is not None,
                            "Invalid context routine digest")
                    cursor.execute("SELECT pg_get_functiondef(to_regprocedure(%s))",
                                   (signature,))
                    body = cursor.fetchone()[0]
                    require(isinstance(body, str)
                            and hashlib.sha256(body.encode()).hexdigest() == expected,
                            "Actual context routine differs from owner-reviewed migration body")
                cursor.execute(
                    "SELECT path,sha256,bytes,phase,execution_mode,source_sha "
                    "FROM lunchlineup_migrations.raw_migration_ledger ORDER BY path"
                )
                keys = ("path", "sha256", "bytes", "phase", "execution_mode", "source_sha")
                actual = [dict(zip(keys, row)) for row in cursor.fetchall()]
                expected = sorted(self.receipt["rawMigrationReceipts"],
                                  key=lambda row: row["path"])
                require(actual == expected, "Full native migration ledger mismatch")
                cursor.execute("SELECT set_current_platform_admin(true,%s)",
                               (self.receipt["platformCapability"],))
                cursor.execute("SELECT is_current_platform_admin()")
                require(cursor.fetchone() == (True,), "Actual platform capability failed")
                for table in ('"Tenant"', '"User"', '"StripeUsageEvent"'):
                    cursor.execute("SELECT COUNT(*) FROM " + table)
                    require(cursor.fetchone() == (0,), "Fixture database is not empty")
        self.verified = True

    def load_worker(self):
        require(self.verified, "Fixture target not verified")
        name = "_ll_billing_native_" + uuid.uuid4().hex
        spec = importlib.util.spec_from_file_location(name, self.source_path)
        require(spec is not None and spec.loader is not None, "Cannot load pinned worker")
        module = importlib.util.module_from_spec(spec)
        sys.modules[name] = module  # dataclass module lookup must see its actual namespace.
        try:
            # Execute exactly the bytes revalidated here, avoiding a loader
            # reread after the hash check. This is future native execution only.
            body = self.source_path.read_bytes()
            require(hashlib.sha256(body).hexdigest() == WORKER_SHA256,
                    "Worker source changed before load")
            exec(compile(body, str(self.source_path), "exec"), module.__dict__)
        except BaseException:
            sys.modules.pop(name, None)
            raise
        return name, module


class FixedClock:
    def __init__(self, module):
        self.current = instant("2026-07-09T19:30:10Z")
        clock = self
        class StageDateTime(datetime):
            @classmethod
            def now(cls, tz=None):
                if tz is None:
                    return clock.current.astimezone(timezone.utc).replace(tzinfo=None)
                return clock.current.astimezone(tz)
        self.patch = patch.object(module, "datetime", StageDateTime)

    def at(self, value):
        self.current = instant(value)


class NoEgressTransport:
    def __init__(self, outcomes):
        self.outcomes = list(outcomes)
        self.captures = []

    def __call__(self, request, timeout):
        require(len(self.captures) < 16, "Fixture capture count exceeded")
        body = request.data
        require(isinstance(body, bytes) and len(body) <= 4096,
                "Fixture client body bound exceeded")
        # Strict allowlist excludes Authorization and arbitrary headers.
        headers = {key.lower(): value for key, value in request.header_items()}
        capture = {
            "body": body, "url": request.full_url, "method": request.get_method(),
            "content_type": headers.get("content-type"),
            "key": headers.get("idempotency-key"),
            "agent": headers.get("user-agent"), "timeout": timeout,
        }
        self.captures.append(capture)
        require(len(self.outcomes) > 0, "Unexpected extra client request")
        outcome = self.outcomes.pop(0)
        if outcome == "timeout":
            raise TimeoutError("Synthetic unknown result")
        if outcome == "reject":
            raise HTTPError(API_BASE + "/v1/billing/meter_events", 400,
                            "Synthetic rejection", {}, io.BytesIO(b""))
        require(outcome == "success", "Invalid fixture transport outcome")
        class Response:
            headers = {"Request-Id": "synthetic-request"}
            def __enter__(self):
                return self
            def __exit__(self, *args):
                return False
            def read(self, maximum):
                require(maximum == 1048576, "Client response read bound changed")
                return b'{"identifier":"synthetic-result"}'
        return Response()

    def decoded(self, index):
        return parse_qs(self.captures[index]["body"].decode("ascii"),
                        strict_parsing=True, keep_blank_values=True)


class Fixture:
    def __init__(self, target, module):
        self.target, self.module = target, module
        self.tenants = []
        self.clock = FixedClock(module)

    @contextmanager
    def context(self, tenant=None):
        with self.target.connect() as connection:
            with connection.cursor() as cursor:
                if tenant is None:
                    cursor.execute("SELECT set_current_platform_admin(true,%s)",
                                   (self.target.receipt["platformCapability"],))
                else:
                    cursor.execute("SELECT set_current_tenant(%s)", (tenant,))
                yield cursor

    def seed(self, suffix="one", tenant_id=None):
        tenant = tenant_id or ("fixture_" + uuid.uuid4().hex + "_" + suffix)
        require(re.fullmatch(r"[A-Za-z0-9_]{1,128}", tenant), "Invalid synthetic identity")
        require(tenant not in self.tenants, "Duplicate owned fixture identity")
        self.tenants.append(tenant)  # Cleanup ownership registered before SQL.
        with self.context() as cursor:
            cursor.execute(
                'INSERT INTO "Tenant" '
                '("id","name","slug","status","stripeCustomerId",'
                '"stripeSubscriptionId","updatedAt") VALUES '
                "(%s,%s,%s,'ACTIVE',%s,%s,%s)",
                (tenant, "Synthetic fixture", tenant, "fixture_customer_A_" + tenant,
                 "fixture_subscription_" + tenant, utc_naive(self.clock.current)),
            )
            for index, role, deleted, suspended in (
                (1, "STAFF", False, False), (2, "MANAGER", False, False),
                (3, "STAFF", False, True), (4, "STAFF", True, False),
            ):
                cursor.execute(
                    'INSERT INTO "User" '
                    '("id","tenantId","name","role","mfaBackupCodes",'
                    '"deletedAt","suspendedAt","updatedAt") '
                    'VALUES (%s,%s,%s,%s::"UserRole",%s,%s,%s,%s)',
                    (tenant + "_u" + str(index), tenant, "Synthetic user", role, [],
                     utc_naive(self.clock.current) if deleted else None,
                     utc_naive(self.clock.current) if suspended else None,
                     utc_naive(self.clock.current)),
                )
        return tenant

    def drift(self, tenant, fields):
        require(tenant in self.tenants, "Unowned tenant mutation")
        with self.context(tenant) as cursor:
            if "count" in fields:
                cursor.execute(
                    'INSERT INTO "User" ("id","tenantId","name","mfaBackupCodes","updatedAt") '
                    'VALUES (%s,%s,%s,%s,%s)',
                    (tenant + "_added", tenant, "Synthetic added", [],
                     utc_naive(self.clock.current)),
                )
            if "customer" in fields:
                cursor.execute(
                    'UPDATE "Tenant" SET "stripeCustomerId"=%s,"updatedAt"=%s WHERE "id"=%s',
                    ("fixture_customer_B_" + tenant, utc_naive(self.clock.current), tenant),
                )
        if "name" in fields:
            os.environ["STRIPE_METER_EVENT_NAME"] = "fixture_staff_B"

    def prepare(self, store, tenant):
        with self.context(tenant) as cursor:
            store._prepare_usage_snapshot(cursor, tenant, self.clock.current)

    def rows(self, tenant):
        with self.context(tenant) as cursor:
            cursor.execute(
                "SELECT " + ",".join('"' + name + '"' for name in ROW_COLUMNS) +
                ' FROM "StripeUsageEvent" WHERE "tenantId"=%s '
                'ORDER BY "periodStart","id"', (tenant,),
            )
            return [dict(zip(ROW_COLUMNS, row)) for row in cursor.fetchall()]

    def one(self, tenant):
        rows = self.rows(tenant)
        require(len(rows) == 1, "Expected exactly one durable tuple")
        return rows[0]

    def cleanup(self):
        failures = []
        for tenant in reversed(self.tenants):
            try:
                with self.context(tenant) as cursor:
                    cursor.execute('DELETE FROM "StripeUsageEvent" WHERE "tenantId"=%s',
                                   (tenant,))
                    cursor.execute('DELETE FROM "User" WHERE "tenantId"=%s', (tenant,))
                    cursor.execute('DELETE FROM "Tenant" WHERE "id"=%s', (tenant,))
            except Exception as exc:
                failures.append(type(exc).__name__)
        if failures:
            self.target.poisoned = True  # Prevent all later cases from opening this target.
        require(not failures, "Exact fixture row cleanup did not complete")

    def store(self):
        return self.module.PostgresUsageStore(database_url=self.target.dsn)

    def client(self):
        return self.module.StripeMeterClient(
            secret_key="synthetic-fixture-secret", api_base=API_BASE,
        )

    def cycle(self, store, transport):
        with patch.object(self.module, "urlopen", transport):
            # Three bounded serial cycle invocations; no worker loop/queue/job.
            # Observation deadline does not cancel to_thread work: the same
            # native settlement and exact cleanup obligations as dispatch apply.
            return asyncio.run(asyncio.wait_for(
                self.module.run_billing_usage_cycle(store=store, client=self.client()),
                timeout=60,
            ))

    def dispatch(self, tenant, store, transport, event_id=None):
        payload = {"tenant_id": tenant}
        if event_id is not None:
            payload["usage_event_id"] = event_id
        with patch.object(self.module, "urlopen", transport):
            # wait_for is only an observation deadline; it does not cancel a
            # to_thread SQL operation. DSN deadlines + asyncio.run executor
            # settlement + cleanup checks are required before any next job.
            return asyncio.run(asyncio.wait_for(
                self.module.dispatch_usage(payload, store=store, client=self.client()),
                timeout=30,
            ))


def payload_view(row):
    return {key: row[key] for key in PAYLOAD_COLUMNS}
