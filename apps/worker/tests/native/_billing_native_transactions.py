"""Delegated native transaction probes for owner-admitted billing fixtures.

SOURCE ONLY, NATIVE UNEXECUTED. No target connection occurs on import.
All SQL/results/transaction exits delegate to real Psycopg objects. Text
classification chooses failpoint placement only, never implements the upsert
predicate, row lock, result, commit or rollback semantics.
"""
from __future__ import annotations

from concurrent.futures import ThreadPoolExecutor
from contextlib import contextmanager
import threading
import time

from _billing_native_target import require


class ControlledTransactionRollback(RuntimeError):
    pass


class TransactionProbe:
    def __init__(self, expected_step, hold_commit=False, rollback=False):
        require(expected_step in {"snapshot_upsert", "claim_update"},
                "Invalid transaction probe step")
        require(not (hold_commit and rollback), "Conflicting transaction failpoints")
        self.expected_step = expected_step
        self.hold_commit = hold_commit
        self.rollback = rollback
        self.connected = threading.Event()
        self.reached = threading.Event()
        self.at_exit = threading.Event()
        self.release = threading.Event()
        self.closed = threading.Event()
        self.pid = None
        self.steps = []
        self.connections = 0
        self.exit_kind = None

    def after_statement(self, query):
        # Classification happens only after the real execute returned.
        require(isinstance(query, str), "Native probe expected pinned text SQL")
        sql = " ".join(query.split())
        if sql.startswith('INSERT INTO "StripeUsageEvent"') and "ON CONFLICT" in sql:
            self.steps.append("snapshot_upsert")
        elif sql.startswith('UPDATE "StripeUsageEvent" SET "status" = \'SENDING\''):
            self.steps.append("claim_update")
        if self.expected_step in self.steps:
            self.reached.set()

    def before_commit(self):
        require(self.expected_step in self.steps, "Expected real statement not completed")
        self.at_exit.set()
        if self.rollback:
            raise ControlledTransactionRollback("Synthetic failure after delegated SQL")
        if self.hold_commit:
            if not self.release.wait(5):
                raise ControlledTransactionRollback("Native commit gate expired")


class DelegatedCursor:
    def __init__(self, cursor, probe):
        self.raw, self.probe = cursor, probe

    def __enter__(self):
        self.raw.__enter__()
        return self

    def __exit__(self, *args):
        return self.raw.__exit__(*args)

    def execute(self, query, params=None, **kwargs):
        result = self.raw.execute(query, params, **kwargs)
        self.probe.after_statement(query)
        return result

    def __getattr__(self, name):
        return getattr(self.raw, name)


class DelegatedConnection:
    def __init__(self, connection, probe):
        self.raw, self.probe = connection, probe

    def __enter__(self):
        try:
            self.raw.__enter__()
            return self
        except BaseException:
            try:
                self.raw.close()
            finally:
                self.probe.closed.set()
            raise

    def cursor(self, *args, **kwargs):
        return DelegatedCursor(self.raw.cursor(*args, **kwargs), self.probe)

    def __exit__(self, exception_type, exception, traceback):
        try:
            if exception_type is None:
                try:
                    self.probe.before_commit()
                except BaseException as controlled:
                    # The actual connection context manager performs rollback,
                    # close and exception propagation. No manual fake row state.
                    self.probe.exit_kind = "controlled_rollback"
                    self.raw.__exit__(type(controlled), controlled, controlled.__traceback__)
                    raise
                self.probe.exit_kind = "commit"
            else:
                self.probe.exit_kind = "exception_rollback"
            return self.raw.__exit__(exception_type, exception, traceback)
        finally:
            # This is exit completion; actual native connection.closed and
            # transaction settlement are independently required by the caller.
            self.probe.closed.set()

    def __getattr__(self, name):
        return getattr(self.raw, name)


class DelegatedDriver:
    def __init__(self, target, probe):
        self.target, self.probe = target, probe
        self.raw_connections = []

    def connect(self, dsn):
        require(dsn == self.target.dsn, "Unexpected native probe target")
        require(self.probe.connections == 0, "Native probe permits one transaction")
        raw = self.target.connect()
        self.raw_connections.append(raw)  # Register ownership before setup can fail.
        self.probe.connections += 1
        try:
            pid = raw.info.backend_pid
            require(isinstance(pid, int) and pid > 0, "Native backend identity missing")
            self.probe.pid = pid
            self.probe.connected.set()
            return DelegatedConnection(raw, self.probe)
        except BaseException:
            self.probe.exit_kind = "connection_setup_failure"
            try:
                raw.close()
            finally:
                self.probe.closed.set()
            raise

    def assert_closed(self):
        if self.probe.connections == 0 and not self.raw_connections:
            return  # No connection was opened; no nonexistent exit to settle.
        require(self.probe.closed.is_set() and self.raw_connections
                and all(connection.closed for connection in self.raw_connections),
                "Native probe connection settlement unproved")


def delegated_prepare(fixture, store, tenant, driver):
    # Equivalent fixture context plumbing, actual production preparation method.
    with driver.connect(fixture.target.dsn) as connection:
        with connection.cursor() as cursor:
            cursor.execute("SELECT set_current_tenant(%s)", (tenant,))
            store._prepare_usage_snapshot(cursor, tenant, fixture.clock.current)


def observe_real_lock(target, waiter, blocker):
    require(waiter.connected.wait(1), "Waiting native connection not established")
    require(blocker.connected.is_set(), "Blocking native connection not established")
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        # At most one independent inspection connection alongside two operations.
        # Never copy SQL predicates or classify local thread waiting as a DB lock.
        with target.connect() as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT wait_event_type, pg_blocking_pids(pid) "
                    "FROM pg_stat_activity WHERE pid=%s", (waiter.pid,),
                )
                row = cursor.fetchone()
        if row is not None and row[0] == "Lock" and blocker.pid in row[1]:
            return {"waiterPid": waiter.pid, "blockerPid": blocker.pid,
                    "waitEventType": row[0], "blockingPids": list(row[1])}
        time.sleep(0.025)
    raise AssertionError("Actual expected PostgreSQL lock wait was not observed")


@contextmanager
def owned_native_jobs(target, *drivers):
    # Only two operation threads, plus main-thread SQL inspection. No worker
    # loop, queue, app server or external provider. Owner must enforce a finite
    # overall process deadline: result timeouts cannot cancel running SQL.
    require(len(drivers) <= 2, "Too many native operations")
    pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="billing-native-fixture")
    try:
        yield pool
    finally:
        for driver in drivers:
            driver.probe.release.set()
        # Native DSN deadlines aid settlement but do not prove TCP/process bounds.
        # If an owner-enforced outer deadline kills this process, retain the
        # failure/target receipt; do not start another job without owner readbacks.
        pool.shutdown(wait=True, cancel_futures=True)
        try:
            for driver in drivers:
                driver.assert_closed()
        except BaseException:
            target.poisoned = True
            raise
