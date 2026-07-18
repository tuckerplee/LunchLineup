import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
import threading
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, Mock, patch

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

import main  # noqa: E402

EXECUTION_TOKEN = "a" * 32


def solve_payload():
    return main.SolvePayload.model_validate({
        "schedule_id": "sch-1",
        "tenant_id": "tenant-1",
        "location_id": "loc-1",
        "start_date": "2026-03-09T00:00:00.000Z",
        "end_date": "2026-03-10T00:00:00.000Z",
        "draft_revision": 0,
        "input_shift_snapshot": [],
        "staff_ids": ["u1"],
    })


def solved_response(*shifts):
    return SimpleNamespace(schedule_id="sch-1", status="SUCCESS", shifts=list(shifts))


def solved_shift(
    staff_id="u1",
    start_time="2026-03-09T09:00:00Z",
    end_time="2026-03-09T17:00:00Z",
    role="STAFF",
    breaks=None,
):
    return SimpleNamespace(
        staff_id=staff_id,
        start_time=start_time,
        end_time=end_time,
        role=role,
        breaks=list(breaks or []),
    )


def solved_break(
    start_time="2026-03-09T12:00:00Z",
    end_time="2026-03-09T12:30:00Z",
    paid=False,
    break_type="meal",
):
    return SimpleNamespace(
        start_time=start_time,
        end_time=end_time,
        paid=paid,
        type=break_type,
    )


class FakePersistenceCursor:
    def __init__(
        self,
        fail_on_break_insert=False,
        fail_on_schedule_revision_update=False,
        schedule_job_status="QUEUED",
        schedule_revision=None,
        shift_rows=None,
        location_active=True,
        location_timezone="UTC",
        tenant_status="ACTIVE",
        tenant_plan="GROWTH",
        tenant_subscription_id="sub_paid_1",
        tenant_subscription_period_current=True,
        schedule_job_execution_token=EXECUTION_TOKEN,
        schedule_job_lease_active=False,
        schedule_job_has_paid_credit_reservation=True,
        schedule_job_credit_consumption=None,
        schedule_job_debit_balance_after=None,
        schedule_job_refund_balance_after=None,
    ):
        self.calls = []
        self.fail_on_break_insert = fail_on_break_insert
        self.fail_on_schedule_revision_update = fail_on_schedule_revision_update
        self.schedule_job_status = schedule_job_status
        self.schedule_job_execution_token = schedule_job_execution_token
        self.schedule_job_lease_active = schedule_job_lease_active
        self.schedule_revision = 0 if schedule_revision is None else schedule_revision
        self.shift_rows = list(shift_rows or [])
        self.location_active = location_active
        self.location_timezone = location_timezone
        self.tenant_status = tenant_status
        self.tenant_plan = tenant_plan
        self.tenant_subscription_id = tenant_subscription_id
        self.tenant_subscription_period_current = tenant_subscription_period_current
        self.schedule_job_has_paid_credit_reservation = schedule_job_has_paid_credit_reservation
        self.schedule_job_credit_consumption = (
            {"source": "credits", "consumedCredits": 1, "newBalance": 0}
            if schedule_job_credit_consumption is None
            else schedule_job_credit_consumption
        )
        self.schedule_job_debit_balance_after = (
            self.schedule_job_credit_consumption.get("newBalance")
            if schedule_job_debit_balance_after is None
            and isinstance(self.schedule_job_credit_consumption, dict)
            else schedule_job_debit_balance_after
        )
        consumed_credits = (
            self.schedule_job_credit_consumption.get("consumedCredits")
            if isinstance(self.schedule_job_credit_consumption, dict)
            else None
        )
        new_balance = (
            self.schedule_job_credit_consumption.get("newBalance")
            if isinstance(self.schedule_job_credit_consumption, dict)
            else None
        )
        self.schedule_job_refund_balance_after = (
            new_balance + consumed_credits
            if schedule_job_refund_balance_after is None
            and type(new_balance) is int
            and type(consumed_credits) is int
            else schedule_job_refund_balance_after
        )
        self.fetchone_result = None
        self.fetchall_result = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        compact_sql = " ".join(sql.split())
        self.calls.append((compact_sql, params))
        if compact_sql.startswith("WITH locked_job AS MATERIALIZED"):
            self.fetchone_result = (
                self.schedule_job_status,
                {"source": "credits", "consumedCredits": 1, "newBalance": 0},
                1,
                "tenant-1",
                -1,
                "Schedule generation (job-1)",
                0,
                0,
                None,
                None,
                None,
                None,
                1,
                1,
                1,
                1,
                1,
            )
        elif 'FROM "Tenant"' in compact_sql:
            self.fetchone_result = (
                (
                    self.tenant_status,
                    self.tenant_plan,
                    self.tenant_subscription_id,
                    self.tenant_subscription_period_current,
                )
                if self.tenant_status and '"stripeSubscriptionId"' in compact_sql
                else ((self.tenant_status,) if self.tenant_status else None)
            )
        elif 'FROM "Location"' in compact_sql:
            self.fetchone_result = ("loc-1", self.location_timezone) if self.location_active else None
        elif compact_sql.startswith('SELECT "tenantId", "scheduleId", "locationId"'):
            self.fetchone_result = (
                ("tenant-1", "sch-1", "loc-1")
                if self.schedule_job_status
                else None
            )
        elif 'FROM "ScheduleSolveJob"' in compact_sql:
            has_debit = self.schedule_job_has_paid_credit_reservation
            refunded = self.schedule_job_status in {"FAILED", "DEAD_LETTERED"}
            claim_result = (
                    self.schedule_job_status,
                    self.schedule_job_execution_token,
                    None,
                    self.schedule_job_lease_active,
                    self.schedule_job_credit_consumption,
                    1 if has_debit else 0,
                    "tenant-1" if has_debit else None,
                    -1 if has_debit else None,
                    "Schedule generation (job-1)" if has_debit else None,
                    self.schedule_job_debit_balance_after if has_debit else None,
                    1 if refunded else 0,
                    "tenant-1" if refunded else None,
                    1 if refunded else None,
                    "Schedule generation refund (job-1)" if refunded else None,
                    self.schedule_job_refund_balance_after if refunded else None,
            )
            persistence_result = (
                self.schedule_job_status,
                self.schedule_job_execution_token,
                self.schedule_job_credit_consumption,
                *claim_result[5:],
            )
            self.fetchone_result = (
                (claim_result if '"executionLeaseUntil"' in compact_sql else persistence_result)
                if self.schedule_job_status
                else None
            )
        elif 'FROM "Schedule"' in compact_sql:
            self.fetchone_result = ("sch-1", "DRAFT", self.schedule_revision)
        elif 'FROM "User"' in compact_sql:
            self.fetchall_result = [("u1",)]
        elif 'FROM "Shift"' in compact_sql and compact_sql.startswith("SELECT"):
            self.fetchall_result = self.shift_rows
        elif 'INSERT INTO "Break"' in compact_sql and self.fail_on_break_insert:
            raise RuntimeError("break insert failed")
        elif compact_sql.startswith('UPDATE "Schedule"') and 'RETURNING "revision"' in compact_sql:
            if self.fail_on_schedule_revision_update:
                raise OverflowError("integer out of range")
            self.schedule_revision += 1
            self.fetchone_result = (self.schedule_revision,)
        elif compact_sql.startswith('UPDATE "ScheduleSolveJob"') and 'RETURNING "id"' in compact_sql:
            self.fetchone_result = ("job-1",)

    def fetchone(self):
        return self.fetchone_result

    def fetchall(self):
        return self.fetchall_result


class FakePersistenceConnection:
    def __init__(
        self,
        fail_on_break_insert=False,
        fail_on_schedule_revision_update=False,
        schedule_job_status="QUEUED",
        schedule_revision=None,
        shift_rows=None,
        location_active=True,
        location_timezone="UTC",
        tenant_status="ACTIVE",
        tenant_plan="GROWTH",
        tenant_subscription_id="sub_paid_1",
        tenant_subscription_period_current=True,
        schedule_job_execution_token=EXECUTION_TOKEN,
        schedule_job_lease_active=False,
        schedule_job_has_paid_credit_reservation=True,
        schedule_job_credit_consumption=None,
        schedule_job_debit_balance_after=None,
        schedule_job_refund_balance_after=None,
    ):
        self.cursor_obj = FakePersistenceCursor(
            fail_on_break_insert=fail_on_break_insert,
            fail_on_schedule_revision_update=fail_on_schedule_revision_update,
            schedule_job_status=schedule_job_status,
            schedule_revision=schedule_revision,
            shift_rows=shift_rows,
            location_active=location_active,
            location_timezone=location_timezone,
            tenant_status=tenant_status,
            tenant_plan=tenant_plan,
            tenant_subscription_id=tenant_subscription_id,
            tenant_subscription_period_current=tenant_subscription_period_current,
            schedule_job_execution_token=schedule_job_execution_token,
            schedule_job_lease_active=schedule_job_lease_active,
            schedule_job_has_paid_credit_reservation=schedule_job_has_paid_credit_reservation,
            schedule_job_credit_consumption=schedule_job_credit_consumption,
            schedule_job_debit_balance_after=schedule_job_debit_balance_after,
            schedule_job_refund_balance_after=schedule_job_refund_balance_after,
        )
        self.exit_exc_type = None

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        self.exit_exc_type = exc_type
        return False

    def cursor(self):
        return self.cursor_obj


class WorkerMessageTests(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        main._COMPLETED_JOB_KEYS.clear()

    def test_unsupported_webhook_jobs_fail_closed(self):
        self.assertNotIn("webhook.deliver", main.JOB_HANDLERS)

    async def test_rejects_solve_jobs_without_tenant_id(self):
        body = json.dumps({
            "type": "schedule.solve",
            "payload": {
                "schedule_id": "sch-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")

        with self.assertRaises(main.NonRetryableJobError):
            await main.process_message(body, message_id="msg-1")

    async def test_process_message_skips_completed_duplicate(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        handler = AsyncMock(return_value={"status": "SUCCESS"})

        with patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}), \
                patch.object(main, "claim_schedule_solve_job", AsyncMock(return_value="claimed")):
            first = await main.process_message(body, message_id="msg-1")
            duplicate = await main.process_message(body, message_id="msg-1")

        self.assertEqual(first, {"status": "SUCCESS"})
        self.assertEqual(duplicate, {"skipped": True})
        handler.assert_awaited_once()

    def test_email_idempotency_uses_durable_outbox_id_without_generic_ids(self):
        first = main.JobMessage.model_validate({
            "type": "email.send",
            "payload": {"outbox_id": "outbox-1"},
        })
        second = main.JobMessage.model_validate({
            "type": "email.send",
            "payload": {"outbox_id": "outbox-2"},
        })

        first_key = main.job_key(first, None)

        self.assertEqual(first_key, main.job_key(first, None))
        self.assertNotEqual(first_key, main.job_key(second, None))

    def test_billing_idempotency_uses_durable_usage_event_id_without_generic_ids(self):
        first = main.JobMessage.model_validate({
            "type": "billing.sync",
            "payload": {
                "tenant_id": "tenant-1",
                "usage_event_id": "usage-1",
            },
        })
        second = main.JobMessage.model_validate({
            "type": "billing.sync",
            "payload": {
                "tenant_id": "tenant-1",
                "usage_event_id": "usage-2",
            },
        })

        first_key = main.job_key(first, None)

        self.assertEqual(first_key, main.job_key(first, None))
        self.assertNotEqual(first_key, main.job_key(second, None))

    def test_idempotency_rejects_invalid_or_missing_durable_identifiers(self):
        invalid_email = main.JobMessage.model_validate({
            "type": "email.send",
            "payload": {"outbox_id": "not an opaque id"},
        })
        missing_billing_id = main.JobMessage.model_validate({
            "type": "billing.sync",
            "payload": {"tenant_id": "tenant-1"},
        })

        with self.assertRaisesRegex(main.NonRetryableJobError, "outbox_id is invalid"):
            main.job_key(invalid_email, None)
        with self.assertRaisesRegex(main.NonRetryableJobError, "requires usage_event_id"):
            main.job_key(missing_billing_id, None)
        with self.assertRaisesRegex(main.NonRetryableJobError, "message_id is invalid"):
            main.job_key(missing_billing_id, "invalid message id")

    async def test_process_message_delays_a_duplicate_with_an_active_owner(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
                "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        handler = AsyncMock()

        with patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}), \
                patch.object(main, "claim_schedule_solve_job", AsyncMock(return_value="busy")):
            with self.assertRaises(main.ScheduleJobBusyError):
                await main.process_message(body, message_id="msg-busy")

        handler.assert_not_awaited()

    async def test_process_message_retries_when_invalid_provenance_cannot_be_terminally_settled(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-corrupt",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
                "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        handler = AsyncMock()

        with patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}), \
                patch.object(
                    main,
                    "claim_schedule_solve_job",
                    AsyncMock(side_effect=main.ScheduleCreditProvenanceError("invalid provenance")),
                ), \
                patch.object(
                    main,
                    "try_mark_schedule_solve_job_status",
                    AsyncMock(side_effect=main.RetryableJobError("debit provenance is invalid")),
                ) as mark_status:
            with self.assertRaises(main.RetryableJobError):
                await main.process_message(body, message_id="msg-corrupt")

        mark_status.assert_awaited_once()
        handler.assert_not_awaited()

    async def test_schedule_solve_requires_job_id_when_database_persistence_is_enabled(self):
        body = json.dumps({
            "type": "schedule.solve",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        handler = AsyncMock(return_value={"status": "SUCCESS"})

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "schedule solve job id is required"):
                await main.process_message(body, message_id="msg-1")

        handler.assert_not_awaited()

    async def test_rejects_oversized_message_body(self):
        body = b"{" + b'"x":' + b'"a"' * main.MAX_MESSAGE_BYTES

        with self.assertRaises(main.NonRetryableJobError):
            await main.process_message(body, message_id="msg-oversized")

    def test_rejects_availability_for_unknown_staff(self):
        with self.assertRaises(main.NonRetryableJobError):
            main.validate_solve_payload({
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
                "availability": {
                    "u2": [{"day_of_week": "monday", "start_time": "08:00", "end_time": "18:00"}],
                },
            })

    def test_rejects_staff_skills_for_unknown_staff(self):
        with self.assertRaises(main.NonRetryableJobError):
            main.validate_solve_payload({
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
                "staff_skills": {"u2": ["lead"]},
            })

    async def test_successful_solve_jobs_are_persisted_before_ack(self):
        class Repeated(list):
            def add(self):
                item = SimpleNamespace(availability=Repeated())
                self.append(item)
                return item

        class ScheduleRequest:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
                self.staff = Repeated()
                self.constraints = Repeated()

        solver_pb2 = SimpleNamespace(ScheduleRequest=ScheduleRequest)
        solver_pb2_grpc = SimpleNamespace()
        response = SimpleNamespace(
            status="SUCCESS",
            schedule_id="sch-1",
            shifts=[
                SimpleNamespace(
                    staff_id="u1",
                    start_time="2026-03-09T09:00:00",
                    end_time="2026-03-09T17:00:00",
                    role="STAFF",
                    breaks=[],
                )
            ],
        )

        with patch.object(main, "load_solver_modules", return_value=(solver_pb2, solver_pb2_grpc)), \
                patch.object(main, "calculate_schedule", new=AsyncMock(return_value=response)), \
                patch.object(main, "persist_solved_schedule", new=AsyncMock()) as persist_solved_schedule:
            result = await main.handle_solve_job({
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            })

        self.assertEqual(result, {"status": "SUCCESS", "schedule_id": "sch-1", "shift_count": 1})
        persist_solved_schedule.assert_awaited_once()

    async def test_solve_job_maps_staff_skills_and_demand_to_engine_request(self):
        class Repeated(list):
            def add(self):
                item = SimpleNamespace()
                self.append(item)
                return item

        class StaffRepeated(list):
            def add(self):
                item = SimpleNamespace(availability=Repeated(), skills=[])
                self.append(item)
                return item

        class ScheduleRequest:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
                self.staff = StaffRepeated()
                self.constraints = Repeated()
                self.existing_weekly_minutes = Repeated()
                self.existing_shifts = Repeated()

        solver_pb2 = SimpleNamespace(ScheduleRequest=ScheduleRequest)
        solver_pb2_grpc = SimpleNamespace()
        response = SimpleNamespace(
            status="SUCCESS",
            schedule_id="sch-1",
            shifts=[
                SimpleNamespace(
                    staff_id="u1",
                    start_time="2026-03-09T09:00:00",
                    end_time="2026-03-09T17:00:00",
                    role="STAFF",
                    breaks=[],
                )
            ],
        )
        captured = {}

        async def fake_calculate_schedule(request, solver_grpc):
            captured["request"] = request
            return response

        with patch.object(main, "load_solver_modules", return_value=(solver_pb2, solver_pb2_grpc)), \
                patch.object(main, "calculate_schedule", new=fake_calculate_schedule), \
                patch.object(main, "persist_solved_schedule", new=AsyncMock()):
            await main.handle_solve_job({
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09",
                "end_date": "2026-03-10",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
                "availability": {"u1": []},
                "availability_configured": {"u1": False},
                "staff_skills": {"u1": ["lead"]},
                "skill_requirements": {"lead": 1},
                "daily_demand": {"2026-03-09": 1},
                "demand_windows": [{
                    "id": "demand-1",
                    "start_time": "2026-03-09T09:00:00.000Z",
                    "end_time": "2026-03-09T17:00:00.000Z",
                    "required_staff": 1,
                    "skill": "lead",
                }],
                "timezone": "America/Los_Angeles",
                "existing_weekly_minutes": {"u1": {"2026-03-09": 360}},
                "existing_shifts": [{
                    "id": "shift-existing",
                    "staff_id": "u1",
                    "location_id": "loc-2",
                    "start_time": "2026-03-09T18:00:00.000Z",
                    "end_time": "2026-03-09T20:00:00.000Z",
                }],
            })

        request = captured["request"]
        self.assertEqual(request.staff[0].skills, ["lead"])
        self.assertFalse(request.staff[0].availability_configured)
        self.assertEqual(list(request.staff[0].availability), [])
        def decode(value):
            try:
                return json.loads(value)
            except json.JSONDecodeError:
                return value

        constraints = {constraint.type: decode(constraint.value) for constraint in request.constraints}
        self.assertEqual(constraints["skill_requirements"], {"lead": 1})
        self.assertEqual(constraints["daily_demand"], {"2026-03-09": 1})
        self.assertEqual(constraints["demand_windows"], [{
            "id": "demand-1",
            "start_time": "2026-03-09T09:00:00.000Z",
            "end_time": "2026-03-09T17:00:00.000Z",
            "required_staff": 1,
            "skill": "lead",
        }])
        self.assertEqual(constraints["timezone"], "America/Los_Angeles")
        self.assertEqual(len(request.existing_weekly_minutes), 1)
        self.assertEqual(request.existing_weekly_minutes[0].staff_id, "u1")
        self.assertEqual(request.existing_weekly_minutes[0].week_start_date, "2026-03-09")
        self.assertEqual(request.existing_weekly_minutes[0].minutes, 360)
        self.assertEqual(len(request.existing_shifts), 1)
        self.assertEqual(request.existing_shifts[0].location_id, "loc-2")
        self.assertEqual(request.existing_shifts[0].staff_id, "u1")

    def test_solve_payload_rejects_non_monday_existing_hours_bucket(self):
        with self.assertRaisesRegex(main.ValidationError, "ISO Monday dates"):
            main.SolvePayload.model_validate({
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09T00:00:00.000Z",
                "end_date": "2026-03-10T00:00:00.000Z",
                "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
                "existing_weekly_minutes": {"u1": {"2026-03-10": 60}},
            })

    async def test_engine_failed_solve_is_terminal_non_retryable(self):
        class Repeated(list):
            def add(self):
                item = SimpleNamespace(availability=Repeated())
                self.append(item)
                return item

        class ScheduleRequest:
            def __init__(self, **kwargs):
                self.__dict__.update(kwargs)
                self.staff = Repeated()
                self.constraints = Repeated()

        solver_pb2 = SimpleNamespace(ScheduleRequest=ScheduleRequest)
        solver_pb2_grpc = SimpleNamespace()
        response = SimpleNamespace(
            status="FAILED",
            reason="No feasible assignment",
            schedule_id="sch-1",
            shifts=[],
        )

        with patch.object(main, "load_solver_modules", return_value=(solver_pb2, solver_pb2_grpc)), \
                patch.object(main, "calculate_schedule", new=AsyncMock(return_value=response)):
            with self.assertRaises(main.NonRetryableJobError):
                await main.handle_solve_job({
                    "schedule_id": "sch-1",
                    "tenant_id": "tenant-1",
                    "location_id": "loc-1",
                    "start_date": "2026-03-09",
                    "end_date": "2026-03-10",
        "draft_revision": 0,
                    "input_shift_snapshot": [],
                    "staff_ids": ["u1"],
                })

    def test_solve_failure_reason_includes_first_infeasible_detail(self):
        response = SimpleNamespace(
            reason="Demand cannot be satisfied",
            infeasible_details=[
                SimpleNamespace(
                    code="skill_demand_unstaffed",
                    date="2026-03-09",
                    skill="lead",
                    required=1,
                    available=0,
                )
            ],
        )

        reason = main.solve_failure_reason(response)

        self.assertIn("Demand cannot be satisfied", reason)
        self.assertIn("skill_demand_unstaffed", reason)
        self.assertIn("skill=lead", reason)

    def test_rejects_duplicate_solved_shifts_before_persistence(self):
        shift = solved_shift()

        with self.assertRaises(main.NonRetryableJobError):
            main.normalize_solved_shifts(solve_payload(), solved_response(shift, shift))

    def test_coalesces_adjacent_same_user_segments_before_persistence(self):
        morning = solved_shift(
            start_time="2026-03-09T09:00:00Z",
            end_time="2026-03-09T13:00:00Z",
        )
        afternoon = solved_shift(
            start_time="2026-03-09T13:00:00Z",
            end_time="2026-03-09T17:00:00Z",
        )

        normalized = main.normalize_solved_shifts(solve_payload(), solved_response(afternoon, morning))
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._persist_solved_schedule_sync(solve_payload(), normalized, "job-1", execution_token=EXECUTION_TOKEN)

        self.assertEqual(len(normalized), 1)
        self.assertEqual(normalized[0].start_time, datetime(2026, 3, 9, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(normalized[0].end_time, datetime(2026, 3, 9, 17, 0, tzinfo=timezone.utc))
        shift_inserts = [sql for sql, _ in fake_connection.cursor_obj.calls if 'INSERT INTO "Shift"' in sql]
        self.assertEqual(len(shift_inserts), 1)

    def test_rejects_true_same_user_segment_overlaps(self):
        first = solved_shift(
            start_time="2026-03-09T09:00:00Z",
            end_time="2026-03-09T13:00:00Z",
        )
        overlapping = solved_shift(
            start_time="2026-03-09T12:59:59Z",
            end_time="2026-03-09T17:00:00Z",
        )

        with self.assertRaisesRegex(main.NonRetryableJobError, "overlapping shifts"):
            main.normalize_solved_shifts(solve_payload(), solved_response(first, overlapping))

    def test_production_runtime_requires_explicit_service_urls(self):
        with patch.dict(os.environ, {}, clear=True), \
                patch.object(main, "ENVIRONMENT", "production"), \
                patch.object(main, "RABBITMQ_URL", "amqp://localhost:5672"), \
                patch.object(main, "ENGINE_GRPC_URL", "engine:50051"):
            with self.assertRaisesRegex(RuntimeError, "RABBITMQ_URL is required"):
                main.validate_runtime_config()

    def test_production_runtime_rejects_guest_rabbitmq_credentials(self):
        with patch.dict(os.environ, {
            "RABBITMQ_URL": "amqp://guest:guest@rabbitmq:5672",
            "ENGINE_GRPC_URL": "engine:50051",
            "DATABASE_URL": "postgresql://worker:secret@postgres:5432/lunchlineup",
        }, clear=True), \
                patch.object(main, "ENVIRONMENT", "production"), \
                patch.object(main, "RABBITMQ_URL", "amqp://guest:guest@rabbitmq:5672"), \
                patch.object(main, "ENGINE_GRPC_URL", "engine:50051"):
            with self.assertRaisesRegex(RuntimeError, "guest credentials"):
                main.validate_runtime_config()

    async def test_consumer_requires_aio_pika_in_production(self):
        with patch.object(main, "ENVIRONMENT", "production"), \
                patch.dict(sys.modules, {"aio_pika": None}):
            with self.assertRaisesRegex(RuntimeError, "aio-pika is required"):
                await main.start_consumer()

    async def test_consumer_allows_explicit_nonproduction_standalone_mode(self):
        with patch.object(main, "ENVIRONMENT", "development"), \
                patch.dict(sys.modules, {"aio_pika": None}), \
                self.assertLogs(main.logger, level="WARNING") as captured:
            await main.start_consumer()

        output = "\n".join(captured.output)
        self.assertIn("standalone mode is allowed only outside production", output)
        self.assertNotIn("RABBITMQ_URL", output)

    async def test_retry_publish_uses_backoff_queue(self):
        published_message = {}

        def message_factory(body, **kwargs):
            published_message.update({"body": body, **kwargs})
            return published_message

        aio_pika = SimpleNamespace(
            Message=message_factory,
            DeliveryMode=SimpleNamespace(PERSISTENT="persistent"),
        )
        exchange = SimpleNamespace(publish=AsyncMock())
        body = json.dumps({
            "type": "schedule.solve",
            "payload": {
                "tenant_id": "tenant-1",
                "schedule_id": "sch-1",
                "location_id": "loc-1",
            },
        }).encode("utf-8")

        with patch.dict(sys.modules, {"aio_pika": aio_pika}):
            await main.publish_retry(exchange, body, retry_count=2, message_id="msg-1")

        exchange.publish.assert_awaited_once()
        self.assertEqual(exchange.publish.await_args.kwargs["routing_key"], main.retry_queue_name(2))
        self.assertEqual(json.loads(published_message["body"].decode("utf-8"))["retry_count"], 2)
        self.assertEqual(published_message["delivery_mode"], "persistent")
        self.assertEqual(published_message["message_id"], "msg-1")
        self.assertEqual(published_message["headers"], {"x-retry-count": 2})

    async def test_consumer_confirms_retry_and_records_recoverable_state_before_ack(self):
        events = []
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "retry_count": 0,
            "payload": {
                "tenant_id": "tenant-1",
                "schedule_id": "sch-1",
                "location_id": "loc-1",
            },
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-1",
            ack=AsyncMock(side_effect=lambda: events.append("ack")),
            nack=AsyncMock(side_effect=lambda **_kwargs: events.append("nack")),
            reject=AsyncMock(side_effect=lambda **_kwargs: events.append("reject")),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(main, "process_message", AsyncMock(side_effect=main.RetryableJobError("temporary"))), \
                patch.object(main, "publish_retry", AsyncMock(side_effect=lambda *_args, **_kwargs: events.append("confirm"))), \
                patch.object(main, "try_mark_schedule_status_from_message", AsyncMock(side_effect=lambda *_args: events.append("state"))):
            await main.handle_queue_message(channel, message)

        self.assertEqual(events, ["confirm", "state", "ack"])
        message.ack.assert_awaited_once()
        message.nack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_consumer_delays_busy_schedule_without_consuming_retry_budget(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "retry_count": 2,
            "payload": {},
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-busy",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(main, "process_message", AsyncMock(side_effect=main.ScheduleJobBusyError("busy"))), \
                patch.object(main, "publish_retry", AsyncMock()) as publish_retry, \
                patch.object(main, "try_mark_schedule_status_from_message", AsyncMock()) as mark_status:
            await main.handle_queue_message(channel, message)

        publish_retry.assert_awaited_once_with(channel.default_exchange, body, 2, "msg-busy")
        mark_status.assert_not_awaited()
        message.ack.assert_awaited_once()
        message.nack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_consumer_acks_stale_schedule_owner_without_terminalizing(self):
        message = SimpleNamespace(
            body=b"{}",
            message_id="msg-stale",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=main.ScheduleJobOwnershipLostError("stale")),
        ):
            await main.handle_queue_message(channel, message)

        message.ack.assert_awaited_once()
        message.nack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_consumer_acks_verified_terminal_schedule_replay_without_dlq(self):
        message = SimpleNamespace(
            body=b"{}",
            message_id="msg-terminal",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(return_value={"skipped": True, "status": "terminal"}),
        ):
            await main.handle_queue_message(channel, message)

        message.ack.assert_awaited_once()
        message.nack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_consumer_settles_a_malformed_schedule_from_authoritative_job_state_before_dlq(self):
        events = []
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "retry_count": main.MAX_RETRIES + 1,
            "payload": {},
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-malformed",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=main.NonRetryableJobError("malformed")),
        ), patch.object(
            main,
            "terminalize_schedule_solve_job_by_id",
            AsyncMock(side_effect=lambda *_args: events.append("settled")),
        ) as terminalize, patch.object(
            main,
            "reject_to_solver_dlq",
            AsyncMock(side_effect=lambda *_args: events.append("dlq")),
        ):
            await main.handle_queue_message(channel, message)

        self.assertEqual(events, ["settled", "dlq"])
        terminalize.assert_awaited_once_with(
            "job-1",
            "DEAD_LETTERED",
            "WORKER_FAILURE_NON_RETRYABLE_JOB",
            main.MAX_RETRIES,
        )
        message.nack.assert_not_awaited()

    async def test_consumer_requeues_malformed_schedule_when_terminal_provenance_fails_closed(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {},
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-malformed",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=main.NonRetryableJobError("malformed")),
        ), patch.object(
            main,
            "terminalize_schedule_solve_job_by_id",
            AsyncMock(side_effect=main.RetryableJobError("debit provenance is invalid")),
        ), patch.object(main, "reject_to_solver_dlq", AsyncMock()) as reject, patch.object(
            main.asyncio,
            "sleep",
            AsyncMock(),
        ) as sleep:
            await main.handle_queue_message(channel, message)

        sleep.assert_awaited_once_with(main.RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
        message.nack.assert_awaited_once_with(requeue=True)
        message.ack.assert_not_awaited()
        reject.assert_not_awaited()

    async def test_consumer_acks_malformed_schedule_when_a_live_replacement_owns_execution(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {},
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-malformed",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=main.NonRetryableJobError("malformed")),
        ), patch.object(
            main,
            "terminalize_schedule_solve_job_by_id",
            AsyncMock(side_effect=main.ScheduleJobOwnershipLostError("live replacement")),
        ), patch.object(main, "reject_to_solver_dlq", AsyncMock()) as reject:
            await main.handle_queue_message(channel, message)

        message.ack.assert_awaited_once()
        message.nack.assert_not_awaited()
        reject.assert_not_awaited()

    async def test_consumer_requeues_original_when_retry_replacement_publish_fails(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "retry_count": 0,
            "payload": {
                "tenant_id": "tenant-1",
                "schedule_id": "sch-1",
                "location_id": "loc-1",
            },
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-1",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(main, "process_message", AsyncMock(side_effect=main.RetryableJobError("temporary"))), \
                patch.object(main, "publish_retry", AsyncMock(side_effect=RuntimeError("broker confirm failed"))), \
                patch.object(main, "try_mark_schedule_status_from_message", AsyncMock()) as mark_status, \
                patch.object(main.asyncio, "sleep", AsyncMock()) as sleep:
            await main.handle_queue_message(channel, message)

        sleep.assert_awaited_once_with(main.RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
        mark_status.assert_not_awaited()
        message.nack.assert_awaited_once_with(requeue=True)
        message.ack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_consumer_requeues_exhausted_job_when_terminal_status_write_fails(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "retry_count": main.MAX_RETRIES,
            "payload": {},
        }).encode("utf-8")
        message = SimpleNamespace(
            body=body,
            message_id="msg-1",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        class ProgrammingError(Exception):
            pass

        ProgrammingError.__module__ = "psycopg.errors"
        cause = ProgrammingError(
            'invalid connection option "connection_limit" in '
            "postgresql://worker:super-secret@db/tenant-42?user=customer@example.com"
        )
        state_error = main.RetryableJobError("failed to update schedule solve job status")
        state_error.__cause__ = cause

        with self.assertLogs(main.logger, level="ERROR") as captured:
            with patch.object(main, "process_message", AsyncMock(side_effect=main.RetryableJobError("temporary"))), \
                    patch.object(main, "try_mark_schedule_status_from_message", AsyncMock(side_effect=state_error)), \
                    patch.object(main.asyncio, "sleep", AsyncMock()) as sleep:
                await main.handle_queue_message(channel, message)

        output = "\n".join(captured.output)
        self.assertIn("operation=terminal_schedule_state_update", output)
        self.assertIn("type=schedule.solve", output)
        self.assertIn("status=DEAD_LETTERED", output)
        self.assertIn("failure_class=database_configuration", output)
        for sensitive in ("super-secret", "tenant-42", "customer@example.com", "connection_limit"):
            self.assertNotIn(sensitive, output)


        sleep.assert_awaited_once_with(main.RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
        message.nack.assert_awaited_once_with(requeue=True)
        message.ack.assert_not_awaited()
        message.reject.assert_not_awaited()

    def test_job_status_reason_uses_allowlisted_codes_without_exception_text(self):
        secret = (
            "postgresql://worker:super-secret@db.internal/tenant-42"
            "?token=secret-token user=customer@example.com"
        )

        class ProgrammingError(Exception):
            pass

        ProgrammingError.__module__ = "psycopg.errors"
        database_error = main.RetryableJobError("failed to update job state")
        database_error.__cause__ = ProgrammingError(f'invalid connection option "secret" in {secret}')
        cases = (
            (database_error, "WORKER_FAILURE_DATABASE_CONFIGURATION"),
            (main.NonRetryableJobError(secret), "WORKER_FAILURE_NON_RETRYABLE_JOB"),
            (ConnectionError(secret), "WORKER_FAILURE_DEPENDENCY_CONNECTIVITY"),
        )

        for error, expected in cases:
            with self.subTest(expected=expected):
                reason = main.job_status_reason(error)
                self.assertEqual(reason, expected)
                self.assertIn(reason, main.JOB_STATUS_REASON_BY_FAILURE_CLASS.values())
                for sensitive in ("super-secret", "secret-token", "tenant-42", "customer@example.com", "db.internal"):
                    self.assertNotIn(sensitive, reason)

    async def test_non_retryable_schedule_failure_persists_only_an_allowlisted_code(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09T00:00:00.000Z",
                "end_date": "2026-03-10T00:00:00.000Z",
                "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        secret = "https://api.internal/fail?token=secret-token Authorization: Bearer hidden"
        handler = AsyncMock(side_effect=main.NonRetryableJobError(secret))

        with patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}), \
                patch.object(main, "claim_schedule_solve_job", AsyncMock(return_value="claimed")), \
                patch.object(main, "try_mark_schedule_solve_job_status", AsyncMock()) as mark_status:
            with self.assertRaises(main.NonRetryableJobError):
                await main.process_message(body, message_id="msg-secret")

        mark_status.assert_awaited_once()
        args = mark_status.await_args.args
        self.assertEqual(args[2], "FAILED")
        self.assertEqual(args[3], "WORKER_FAILURE_NON_RETRYABLE_JOB")
        self.assertEqual(args[4], 0)
        self.assertNotIn("secret-token", repr(args))
        self.assertNotIn("api.internal", repr(args))
        self.assertNotIn("Bearer hidden", repr(args))

    async def test_retry_and_terminal_status_handoffs_preserve_state_with_safe_codes(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09T00:00:00.000Z",
                "end_date": "2026-03-10T00:00:00.000Z",
                "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        secret = "redis://default:secret-password@redis.internal/0?token=secret-token"

        for status, retry_count in (("RETRYING", 1), ("DEAD_LETTERED", main.MAX_RETRIES)):
            error = main.RetryableJobError(secret)
            setattr(error, "schedule_execution_token", "a" * 32)
            with self.subTest(status=status), patch.object(
                main,
                "try_mark_schedule_solve_job_status",
                AsyncMock(),
            ) as mark_status:
                await main.try_mark_schedule_status_from_message(body, status, error, retry_count)

            args = mark_status.await_args.args
            self.assertEqual(args[2], status)
            self.assertEqual(args[3], "WORKER_FAILURE_RETRYABLE_JOB")
            self.assertEqual(args[4], retry_count)
            self.assertEqual(args[5], "a" * 32)
            self.assertNotIn("secret-password", repr(args))
            self.assertNotIn("redis.internal", repr(args))
            self.assertNotIn("secret-token", repr(args))
    async def test_process_failure_does_not_mark_retrying_before_consumer_publication(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "payload": {
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-09T00:00:00.000Z",
                "end_date": "2026-03-10T00:00:00.000Z",
        "draft_revision": 0,
                "input_shift_snapshot": [],
                "staff_ids": ["u1"],
            },
        }).encode("utf-8")
        handler = AsyncMock(side_effect=main.RetryableJobError("engine unavailable"))

        with patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}), \
                patch.object(main, "claim_schedule_solve_job", AsyncMock(return_value=True)), \
                patch.object(main, "try_mark_schedule_solve_job_status", AsyncMock()) as mark_status:
            with self.assertRaises(main.RetryableJobError):
                await main.process_message(body, message_id="msg-1")

        mark_status.assert_not_awaited()

    async def test_retry_queues_dead_letter_back_to_main_queue_with_backoff(self):
        declared = []
        channel = SimpleNamespace(declare_queue=AsyncMock(side_effect=lambda name, **kwargs: declared.append((name, kwargs))))

        await main.declare_retry_queues(channel)

        self.assertGreaterEqual(len(declared), 1)
        first_name, first_kwargs = declared[0]
        self.assertEqual(first_name, main.retry_queue_name(1))
        self.assertEqual(first_kwargs["durable"], True)
        self.assertEqual(first_kwargs["arguments"]["x-message-ttl"], main.retry_delay_ms(1))
        self.assertEqual(first_kwargs["arguments"]["x-dead-letter-routing-key"], main.QUEUE_NAME)

    def test_solver_queue_telemetry_updates_compatible_total_and_all_states(self):
        telemetry = main.SolverQueueTelemetry(ready=7, retry=3, dead_letter=1)

        with patch.object(main.SOLVER_QUEUE_DEPTH, "set") as set_total, \
                patch.object(main.SOLVER_QUEUE_TELEMETRY_AVAILABLE, "set") as set_available:
            main.update_solver_queue_telemetry(telemetry)

        set_total.assert_called_once_with(10)
        set_available.assert_called_once_with(1)
        samples = {
            sample.labels["state"]: sample.value
            for sample in main.SOLVER_QUEUE_MESSAGES.collect()[0].samples
            if sample.name == "lunchlineup_solver_queue_messages"
        }
        self.assertEqual(samples, {"ready": 7, "retry": 3, "dead_letter": 1})

    async def test_solver_queue_telemetry_refresh_passively_sums_retry_queues(self):
        depths = {
            main.QUEUE_NAME: 9,
            main.DLQ_NAME: 1,
            **{
                main.retry_queue_name(retry_count): retry_count
                for retry_count in range(1, main.declared_retry_queue_count() + 1)
            },
        }

        async def declare_queue(name, **_kwargs):
            return SimpleNamespace(
                declaration_result=SimpleNamespace(message_count=depths[name]),
            )

        channel = SimpleNamespace(declare_queue=AsyncMock(side_effect=declare_queue))
        telemetry = await main.refresh_solver_queue_telemetry(channel)

        self.assertEqual(
            telemetry,
            main.SolverQueueTelemetry(
                ready=9,
                retry=sum(range(1, main.declared_retry_queue_count() + 1)),
                dead_letter=1,
            ),
        )
        for declared in channel.declare_queue.await_args_list:
            self.assertEqual(declared.kwargs, {"passive": True})

    async def test_solver_queue_telemetry_failure_marks_snapshot_unavailable(self):
        channel = SimpleNamespace(
            declare_queue=AsyncMock(side_effect=ConnectionError("broker unavailable")),
        )

        with patch.object(main.SOLVER_QUEUE_TELEMETRY_AVAILABLE, "set") as set_available:
            with self.assertRaises(ConnectionError):
                await main.refresh_solver_queue_telemetry(channel)

        set_available.assert_called_once_with(0)

    async def test_deterministic_broker_poison_routes_one_message_to_dlq_and_reports_depth(self):
        class DeterministicBroker:
            def __init__(self):
                self.depths = {
                    main.QUEUE_NAME: 0,
                    main.DLQ_NAME: 0,
                    **{
                        main.retry_queue_name(retry_count): 0
                        for retry_count in range(1, main.declared_retry_queue_count() + 1)
                    },
                }
                self.default_exchange = object()

            def publish(self, queue_name, body):
                self.depths[queue_name] += 1
                return body

            def consume(self, queue_name, body):
                self.depths[queue_name] -= 1

                async def reject(*, requeue):
                    self.assert_false(requeue)
                    self.depths[main.DLQ_NAME] += 1

                return SimpleNamespace(
                    body=body,
                    message_id="poison-1",
                    ack=AsyncMock(),
                    nack=AsyncMock(),
                    reject=AsyncMock(side_effect=reject),
                )

            async def declare_queue(self, queue_name, **_kwargs):
                return SimpleNamespace(
                    declaration_result=SimpleNamespace(
                        message_count=self.depths[queue_name],
                    ),
                )

            @staticmethod
            def assert_false(value):
                if value:
                    raise AssertionError("poison message must not be requeued")

        broker = DeterministicBroker()
        body = broker.publish(main.QUEUE_NAME, b'{"type":"poison"}')
        message = broker.consume(main.QUEUE_NAME, body)
        terminal_counter = main.SOLVER_TERMINAL_TRANSITIONS.labels(reason="non_retryable")
        terminal_before = terminal_counter._value.get()

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=main.NonRetryableJobError("poison")),
        ):
            await main.handle_queue_message(broker, message)
        telemetry = await main.refresh_solver_queue_telemetry(broker)

        self.assertEqual(telemetry.dead_letter, 1)
        self.assertEqual(terminal_counter._value.get(), terminal_before + 1)
        message.reject.assert_awaited_once_with(requeue=False)
        message.ack.assert_not_awaited()

    async def test_billing_sync_jobs_dispatch_durable_usage(self):
        with patch.object(main, "dispatch_usage", AsyncMock(return_value={
            "sent": True,
            "usage_event_id": "usage-1",
        })) as dispatch:
            result = await main.handle_billing_sync({"tenant_id": "tenant-1"})

        dispatch.assert_awaited_once_with({"tenant_id": "tenant-1"})
        self.assertEqual(result["usage_event_id"], "usage-1")

    async def test_billing_sync_jobs_preserve_retryable_delivery_failures(self):
        with patch.object(
            main,
            "dispatch_usage",
            AsyncMock(side_effect=main.RetryableBillingError("temporary Stripe failure")),
        ):
            with self.assertRaises(main.RetryableJobError):
                await main.handle_billing_sync({"tenant_id": "tenant-1"})

    async def test_email_jobs_require_an_opaque_outbox_id(self):
        with self.assertRaisesRegex(main.NonRetryableJobError, "opaque outbox_id"):
            await main.handle_email_job({"to": "user@example.com", "template": "welcome"})

    async def test_email_jobs_route_through_the_durable_outbox_dispatcher(self):
        with patch.object(main, "dispatch_password_reset_email", AsyncMock(return_value={"delivered": True})) as dispatch:
            result = await main.handle_email_job({"outbox_id": "outbox-1"})

        dispatch.assert_awaited_once_with("outbox-1")
        self.assertEqual(result, {"delivered": True})

    async def test_password_reset_sweep_failure_is_worker_fatal(self):
        consumer_cancelled = asyncio.Event()
        never = asyncio.Event()

        async def consume(_queue, _channel, _shutdown):
            try:
                await never.wait()
            finally:
                consumer_cancelled.set()

        async def fail_sweep():
            raise ConnectionError("database unavailable")

        with (
            patch.object(main, "consume_queue", new=consume),
            patch.object(main, "metered_usage_enabled", return_value=False),
            patch.object(main, "password_reset_email_enabled", return_value=True),
            patch.object(main, "run_password_reset_email_loop", new=fail_sweep),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Required background task failed: password-reset-email-sweep",
            ) as raised:
                await main.run_worker_tasks(object(), object())

        self.assertIsInstance(raised.exception.__cause__, ConnectionError)
        self.assertTrue(consumer_cancelled.is_set())

    async def test_consumer_completion_cancels_password_reset_sweep_cleanly(self):
        sweep_started = asyncio.Event()
        sweep_cancelled = asyncio.Event()
        never = asyncio.Event()

        async def consume(_queue, _channel, _shutdown):
            await sweep_started.wait()

        async def run_sweep():
            sweep_started.set()
            try:
                await never.wait()
            finally:
                sweep_cancelled.set()

        with (
            patch.object(main, "consume_queue", new=consume),
            patch.object(main, "metered_usage_enabled", return_value=False),
            patch.object(main, "password_reset_email_enabled", return_value=True),
            patch.object(main, "run_password_reset_email_loop", new=run_sweep),
        ):
            with self.assertRaisesRegex(
                RuntimeError,
                "Required background task exited unexpectedly: rabbitmq-consumer",
            ):
                await main.run_worker_tasks(object(), object())

        self.assertTrue(sweep_cancelled.is_set())

    async def test_signal_during_claim_drains_provider_and_db_commit_before_ack(self):
        events = []
        claim_started = asyncio.Event()
        release_claim = asyncio.Event()
        db_commit_started = asyncio.Event()
        release_db_commit = asyncio.Event()
        iterator_closed = asyncio.Event()
        shutdown = main.ShutdownCoordinator(timeout_seconds=1)

        first_message = SimpleNamespace(
            body=b"first",
            message_id="first",
            ack=AsyncMock(side_effect=lambda: events.append("ack")),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        second_message = SimpleNamespace(
            body=b"second",
            message_id="second",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )

        class QueueIterator:
            def __init__(self):
                self.messages = iter((first_message, second_message))
                self.closed = False

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                await self.close()

            def __aiter__(self):
                return self

            async def __anext__(self):
                if self.closed:
                    raise StopAsyncIteration
                try:
                    return next(self.messages)
                except StopIteration:
                    raise StopAsyncIteration from None

            async def close(self):
                self.closed = True
                iterator_closed.set()

        queue_iterator = QueueIterator()
        queue = SimpleNamespace(iterator=lambda: queue_iterator)
        channel = SimpleNamespace(default_exchange=object())

        async def process(_body, message_id=None):
            self.assertEqual(message_id, "first")
            events.append("claim")
            claim_started.set()
            await release_claim.wait()
            events.append("provider")
            db_commit_started.set()
            await release_db_commit.wait()
            events.append("db_settled")

        with patch.object(main, "process_message", new=process):
            consumer = asyncio.create_task(
                main.consume_queue(queue, channel, shutdown)
            )
            await claim_started.wait()
            self.assertEqual(main.WORKER_READY._value.get(), 1)

            shutdown.request("signal_sigterm", signal_number=15)
            await iterator_closed.wait()
            self.assertEqual(main.WORKER_READY._value.get(), 0)
            release_claim.set()
            await db_commit_started.wait()
            self.assertFalse(consumer.done())
            first_message.ack.assert_not_awaited()

            release_db_commit.set()
            await consumer

        self.assertEqual(events, ["claim", "provider", "db_settled", "ack"])
        first_message.ack.assert_awaited_once()
        first_message.nack.assert_not_awaited()
        second_message.ack.assert_not_awaited()
        second_message.nack.assert_not_awaited()

    async def test_signal_after_delivery_before_claim_nacks_without_acking(self):
        shutdown = main.ShutdownCoordinator(timeout_seconds=1)
        message = SimpleNamespace(
            body=b"not-claimed",
            message_id="not-claimed",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )

        class QueueIterator:
            delivered = False

            async def __aenter__(self):
                return self

            async def __aexit__(self, *_args):
                return None

            def __aiter__(self):
                return self

            async def __anext__(self):
                if self.delivered:
                    raise StopAsyncIteration
                self.delivered = True
                shutdown.request("signal_sigint", signal_number=2)
                return message

            async def close(self):
                return None

        queue = SimpleNamespace(iterator=QueueIterator)
        channel = SimpleNamespace(default_exchange=object())
        with patch.object(main, "process_message", AsyncMock()) as process:
            await main.consume_queue(queue, channel, shutdown)

        process.assert_not_awaited()
        message.nack.assert_awaited_once_with(requeue=True)
        message.ack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_delivery_cancellation_preserves_retry_budget_and_refund_state(self):
        message = SimpleNamespace(
            body=b"cancelled",
            message_id="cancelled",
            ack=AsyncMock(),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=asyncio.CancelledError()),
        ), patch.object(
            main,
            "publish_retry",
            AsyncMock(),
        ) as publish_retry, patch.object(
            main,
            "try_mark_schedule_status_from_message",
            AsyncMock(),
        ) as mark_status, patch.object(
            main,
            "terminalize_schedule_solve_job_by_id",
            AsyncMock(),
        ) as terminalize:
            with self.assertRaises(asyncio.CancelledError):
                await main.handle_queue_message(channel, message)

        publish_retry.assert_not_awaited()
        mark_status.assert_not_awaited()
        terminalize.assert_not_awaited()
        message.ack.assert_not_awaited()
        message.nack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_shutdown_during_busy_replacement_ack_keeps_retry_budget_stable(self):
        body = json.dumps({
            "type": "schedule.solve",
            "job_id": "job-1",
            "retry_count": 2,
            "payload": {},
        }).encode("utf-8")
        ack_started = asyncio.Event()
        never = asyncio.Event()

        async def stuck_ack():
            ack_started.set()
            await never.wait()

        message = SimpleNamespace(
            body=body,
            message_id="busy-replacement",
            ack=AsyncMock(side_effect=stuck_ack),
            nack=AsyncMock(),
            reject=AsyncMock(),
        )
        channel = SimpleNamespace(default_exchange=object())

        with patch.object(
            main,
            "process_message",
            AsyncMock(side_effect=main.ScheduleJobBusyError("live replacement")),
        ), patch.object(
            main,
            "publish_retry",
            AsyncMock(),
        ) as publish_retry, patch.object(
            main,
            "try_mark_schedule_status_from_message",
            AsyncMock(),
        ) as mark_status:
            delivery = asyncio.create_task(
                main.handle_queue_message(channel, message)
            )
            await ack_started.wait()
            delivery.cancel()
            with self.assertRaises(asyncio.CancelledError):
                await delivery

        publish_retry.assert_awaited_once_with(
            channel.default_exchange,
            body,
            2,
            "busy-replacement",
        )
        mark_status.assert_not_awaited()
        message.nack.assert_not_awaited()
        message.reject.assert_not_awaited()

    async def test_worker_drain_timeout_is_aggregate_and_force_closes_grpc(self):
        started = asyncio.Event()
        release = asyncio.Event()
        shutdown = main.ShutdownCoordinator(timeout_seconds=0.02)

        async def cancellation_resistant_consumer(_queue, _channel, _shutdown):
            started.set()
            while not release.is_set():
                try:
                    await release.wait()
                except asyncio.CancelledError:
                    continue

        async def idle_loop():
            await asyncio.Event().wait()

        with (
            patch.object(main, "consume_queue", new=cancellation_resistant_consumer),
            patch.object(main, "run_solver_queue_telemetry_loop", new=lambda _channel: idle_loop()),
            patch.object(main, "run_pdf_parser_health_loop", new=idle_loop),
            patch.object(main, "run_availability_import_retention_loop", new=idle_loop),
            patch.object(main, "metered_usage_enabled", return_value=False),
            patch.object(main, "password_reset_email_enabled", return_value=False),
            patch.object(main, "staff_invitation_outbox_enabled", return_value=False),
            patch.object(main, "force_close_active_grpc_channels") as force_grpc,
        ):
            worker = asyncio.create_task(
                main.run_worker_tasks(object(), object(), shutdown)
            )
            await started.wait()
            shutdown.request("signal_sigterm", signal_number=15)
            with self.assertRaisesRegex(
                main.WorkerDrainTimeout,
                "rabbitmq-consumer",
            ):
                await worker
            force_grpc.assert_called_once()
            self.assertEqual(main.WORKER_READY._value.get(), 0)
            release.set()
            await asyncio.sleep(0)

    async def test_stuck_rabbit_close_is_aborted_at_the_shared_deadline(self):
        never = asyncio.Event()
        transport = SimpleNamespace(abort=Mock())

        async def stuck_close():
            await never.wait()

        connection = SimpleNamespace(
            close=AsyncMock(side_effect=stuck_close),
            transport=transport,
        )
        shutdown = main.ShutdownCoordinator(timeout_seconds=0.01)
        shutdown.request("signal_sigterm", signal_number=15)

        with self.assertRaises(main.WorkerDrainTimeout):
            await main.close_rabbit_connection(
                connection,
                SimpleNamespace(),
                shutdown,
            )

        transport.abort.assert_called_once()

    async def test_stuck_grpc_close_forces_the_core_channel_closed(self):
        never = asyncio.Event()
        core_channel = SimpleNamespace(close=Mock())
        channel = Mock()

        async def stuck_close(**_kwargs):
            await never.wait()

        channel.close = AsyncMock(side_effect=stuck_close)
        channel._channel = core_channel

        with patch.object(main, "GRPC_CLOSE_TIMEOUT_SECONDS", 0.01):
            await main.close_grpc_channel(channel)

        core_channel.close.assert_called_once()

    async def test_stuck_metrics_server_is_force_closed_at_the_shared_deadline(self):
        release = threading.Event()
        server_socket = SimpleNamespace(shutdown=Mock(), close=Mock())
        server = SimpleNamespace(
            shutdown=lambda: release.wait(),
            server_close=Mock(),
            socket=server_socket,
        )
        shutdown = main.ShutdownCoordinator(timeout_seconds=0.01)
        shutdown.request("signal_sigterm", signal_number=15)
        main._METRICS_SERVER = server
        main._METRICS_THREAD = threading.current_thread()
        main._METRICS_STARTED = True
        try:
            self.assertFalse(await main.stop_metrics_server(shutdown))
        finally:
            release.set()

        server_socket.shutdown.assert_called_once()
        server_socket.close.assert_called_once()

    def test_signal_exit_codes_preserve_process_semantics(self):
        shutdown = main.ShutdownCoordinator(timeout_seconds=1)
        shutdown.request("signal_sigterm", signal_number=15)
        self.assertEqual(main.shutdown_exit_code(shutdown), 143)


    def test_rejects_breaks_outside_their_shift(self):
        response = solved_response(solved_shift(breaks=[
            solved_break(
                start_time="2026-03-09T08:30:00Z",
                end_time="2026-03-09T09:15:00Z",
            ),
        ]))

        with self.assertRaises(main.NonRetryableJobError):
            main.normalize_solved_shifts(solve_payload(), response)

    def test_preserves_default_break_types_from_engine_response(self):
        response = solved_response(solved_shift(breaks=[
            solved_break(start_time="2026-03-09T11:00:00Z", end_time="2026-03-09T11:10:00Z", break_type="break1"),
            solved_break(start_time="2026-03-09T13:00:00Z", end_time="2026-03-09T13:30:00Z", break_type="lunch"),
            solved_break(start_time="2026-03-09T15:00:00Z", end_time="2026-03-09T15:10:00Z", break_type="break2"),
        ]))

        normalized = main.normalize_solved_shifts(solve_payload(), response)

        self.assertEqual([item.break_type for item in normalized[0].breaks], ["BREAK1", "LUNCH", "BREAK2"])

    def test_rejects_overlapping_solved_breaks_before_persistence(self):
        response = solved_response(solved_shift(breaks=[
            solved_break(
                start_time="2026-03-09T12:00:00Z",
                end_time="2026-03-09T12:30:00Z",
            ),
            solved_break(
                start_time="2026-03-09T12:15:00Z",
                end_time="2026-03-09T12:45:00Z",
                break_type="break2",
            ),
        ]))

        with self.assertRaisesRegex(main.NonRetryableJobError, "overlapping breaks"):
            main.normalize_solved_shifts(solve_payload(), response)

    def test_rejects_solved_demand_that_counts_staff_during_breaks(self):
        payload = main.SolvePayload.model_validate({
            "schedule_id": "sch-1",
            "tenant_id": "tenant-1",
            "location_id": "loc-1",
            "start_date": "2026-03-09T00:00:00.000Z",
            "end_date": "2026-03-10T00:00:00.000Z",
        "draft_revision": 0,
            "staff_ids": ["u1"],
            "demand_windows": [{
                "id": "demand-1",
                "start_time": "2026-03-09T09:00:00Z",
                "end_time": "2026-03-09T17:00:00Z",
                "required_staff": 1,
            }],
        })
        normalized = main.normalize_solved_shifts(
            payload,
            solved_response(solved_shift(breaks=[solved_break()])),
        )

        with self.assertRaisesRegex(main.NonRetryableJobError, "during a break"):
            main.validate_solved_demand_coverage(payload, normalized)

    def test_rejects_daily_demand_that_counts_the_only_worker_during_a_break(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(
            payload,
            solved_response(solved_shift(breaks=[solved_break()])),
        )

        with self.assertRaisesRegex(main.NonRetryableJobError, "daily demand"):
            main.validate_solved_demand_coverage(payload, normalized)

    def test_accepts_staggered_breaks_that_preserve_actual_demand(self):
        payload = main.SolvePayload.model_validate({
            "schedule_id": "sch-1",
            "tenant_id": "tenant-1",
            "location_id": "loc-1",
            "start_date": "2026-03-09T00:00:00.000Z",
            "end_date": "2026-03-10T00:00:00.000Z",
        "draft_revision": 0,
            "staff_ids": ["u1", "u2"],
            "demand_windows": [{
                "id": "demand-1",
                "start_time": "2026-03-09T09:00:00Z",
                "end_time": "2026-03-09T17:00:00Z",
                "required_staff": 1,
            }],
        })
        normalized = main.normalize_solved_shifts(payload, solved_response(
            solved_shift(staff_id="u1", breaks=[solved_break()]),
            solved_shift(staff_id="u2", breaks=[solved_break(
                start_time="2026-03-09T12:30:00Z",
                end_time="2026-03-09T13:00:00Z",
            )]),
        ))

        main.validate_solved_demand_coverage(payload, normalized)

    def test_solve_payload_rejects_invalid_date_windows(self):
        with self.assertRaises(main.NonRetryableJobError):
            main.validate_solve_payload({
                "schedule_id": "sch-1",
                "tenant_id": "tenant-1",
                "location_id": "loc-1",
                "start_date": "2026-03-10T00:00:00.000Z",
                "end_date": "2026-03-09T00:00:00.000Z",
                "staff_ids": ["u1"],
            })

    def test_persist_uses_locks_and_deterministic_shift_identity(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift(breaks=[solved_break()])))
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
        sql_text = "\n".join(statements)
        tenant_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "Tenant"' in sql)
        advisory_lock_index = next(index for index, sql in enumerate(statements) if 'pg_advisory_xact_lock' in sql)
        schedule_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "Schedule"' in sql)
        job_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "ScheduleSolveJob"' in sql)
        self.assertLess(tenant_lock_index, advisory_lock_index)
        self.assertLess(advisory_lock_index, schedule_lock_index)
        self.assertLess(schedule_lock_index, job_lock_index)
        self.assertIn('FROM "Schedule"', sql_text)
        self.assertIn('"deletedAt" IS NULL', sql_text)
        self.assertIn('"suspendedAt" IS NULL', sql_text)
        self.assertIn("FOR UPDATE", sql_text)
        shift_insert = next(params for sql, params in fake_connection.cursor_obj.calls if 'INSERT INTO "Shift"' in sql)
        break_insert = next(params for sql, params in fake_connection.cursor_obj.calls if 'INSERT INTO "Break"' in sql)
        self.assertEqual(shift_insert[0], normalized[0].id)
        self.assertEqual(shift_insert[5], datetime(2026, 3, 9, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(break_insert[1], normalized[0].id)
        self.assertEqual(break_insert[2], "LUNCH")
        revision_update = next(
            params for sql, params in fake_connection.cursor_obj.calls
            if sql.startswith('UPDATE "Schedule"')
        )
        self.assertEqual(revision_update, ("sch-1", "tenant-1", "loc-1", 0))
        success_update = next(
            params for sql, params in fake_connection.cursor_obj.calls
            if 'UPDATE "ScheduleSolveJob"' in sql
        )
        self.assertEqual(success_update[:3], (0, 1, "job-1"))

    def test_persist_is_idempotent_when_the_durable_job_already_succeeded(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(schedule_job_status="SUCCEEDED")

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "ScheduleSolveJob"', sql_text)
        self.assertNotIn('INSERT INTO "Shift"', sql_text)
        self.assertNotIn('UPDATE "Schedule"', sql_text)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_persist_rejects_non_entitled_tenants_before_any_persistence_write(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))

        for tenant_status in ("TRIAL", "PAST_DUE", "SUSPENDED", "CANCELLED", "PURGED"):
            with self.subTest(tenant_status=tenant_status):
                fake_connection = FakePersistenceConnection(tenant_status=tenant_status)

                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}):
                    with patch.dict(
                        sys.modules,
                        {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)},
                    ):
                        with self.assertRaisesRegex(main.NonRetryableJobError, "active paid subscription"):
                            main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

                statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
                tenant_lock_index = next(
                    index for index, sql in enumerate(statements) if 'FROM "Tenant"' in sql
                )
                self.assertIn("FOR UPDATE", statements[tenant_lock_index])
                sql_text = "\n".join(statements)
                self.assertNotIn('FROM "Location"', sql_text)
                self.assertNotIn('FROM "ScheduleSolveJob"', sql_text)
                self.assertFalse(
                    any(sql.startswith(("INSERT ", "UPDATE ", "DELETE ")) for sql in statements)
                )

    def test_persist_rejects_free_or_noncurrent_paid_entitlement_before_shift_or_revision_writes(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        cases = [
            ("free", "FREE", True),
            ("null_period_end", "GROWTH", None),
            ("past_period_end", "GROWTH", False),
        ]

        for case, tenant_plan, period_current in cases:
            with self.subTest(
                case=case,
                tenant_plan=tenant_plan,
                period_current=period_current,
            ):
                fake_connection = FakePersistenceConnection(
                    tenant_plan=tenant_plan,
                    tenant_subscription_period_current=period_current,
                )
                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                        patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
                    with self.assertRaisesRegex(main.NonRetryableJobError, "active paid subscription"):
                        main._persist_solved_schedule_sync(
                            payload,
                            normalized,
                            "job-1",
                            execution_token=EXECUTION_TOKEN,
                        )

                sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
                self.assertNotIn('FROM "Shift"', sql_text)
                self.assertNotIn('UPDATE "Schedule"', sql_text)

    def test_persist_rejects_manual_shift_edits_after_queueing(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(
            shift_rows=[("manual-shift-1", datetime(2026, 3, 8, 21, 0))],
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "draft shifts changed"):
                main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertNotIn('INSERT INTO "Shift"', sql_text)

    def test_persist_rejects_schedule_revision_changes_after_queueing(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(
            schedule_revision=1,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "draft changed"):
                main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertNotIn('FROM "Shift"', sql_text)

    def test_persist_rejects_deleted_location_before_locking_or_writing_schedule(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(location_active=False)

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "location is not active"):
                main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "Location"', sql_text)
        self.assertNotIn('FROM "Schedule"', sql_text)
        self.assertNotIn('INSERT INTO "Shift"', sql_text)

    def test_persist_rejects_location_timezone_change_before_locking_or_writing_schedule(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(location_timezone="America/New_York")

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "location timezone changed"):
                main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "Location"', sql_text)
        self.assertIn('FOR UPDATE', sql_text)
        self.assertNotIn('FROM "Schedule"', sql_text)
        self.assertNotIn('INSERT INTO "Shift"', sql_text)

    def test_persist_rolls_back_when_break_insert_fails(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift(breaks=[solved_break()])))
        fake_connection = FakePersistenceConnection(fail_on_break_insert=True)

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaises(main.RetryableJobError):
                main._persist_solved_schedule_sync(payload, normalized, "job-1", execution_token=EXECUTION_TOKEN)

        self.assertIs(fake_connection.exit_exc_type, RuntimeError)

    def test_persist_fails_closed_when_schedule_revision_overflows(self):
        payload = solve_payload().model_copy(update={"draft_revision": main.POSTGRES_INTEGER_MAX})
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(
            schedule_revision=main.POSTGRES_INTEGER_MAX,
            fail_on_schedule_revision_update=True,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaises(main.RetryableJobError):
                main._persist_solved_schedule_sync(
                    payload,
                    normalized,
                    "job-1",
                    execution_token=EXECUTION_TOKEN,
                )

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('UPDATE "Schedule"', sql_text)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)
        self.assertIs(fake_connection.exit_exc_type, OverflowError)

    def test_schedule_solve_job_claim_marks_running(self):
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            claimed = main._claim_schedule_solve_job_sync(
                solve_payload(),
                "job-1",
                retry_count=2,
                execution_token=EXECUTION_TOKEN,
            )

        self.assertEqual(claimed, "claimed")
        statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
        sql_text = "\n".join(statements)
        tenant_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "Tenant"' in sql)
        job_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "ScheduleSolveJob"' in sql)
        self.assertLess(tenant_lock_index, job_lock_index)
        self.assertIn('FROM "ScheduleSolveJob"', sql_text)
        self.assertIn('UPDATE "ScheduleSolveJob"', sql_text)
        update_sql, update_params = next(
            (sql, params) for sql, params in fake_connection.cursor_obj.calls
            if 'UPDATE "ScheduleSolveJob"' in sql
        )
        self.assertTrue(update_sql.startswith('UPDATE "ScheduleSolveJob"'))
        self.assertNotIn("WITH updated_job", update_sql)
        self.assertEqual(update_params[0], 2)
        self.assertEqual(update_params[1], EXECUTION_TOKEN)
        self.assertEqual(update_params[2], main.SCHEDULE_SOLVE_EXECUTION_LEASE_SECONDS)
        self.assertEqual(update_params[3], "job-1")

    def test_schedule_solve_job_claim_rejects_missing_durable_row(self):
        fake_connection = FakePersistenceConnection(schedule_job_status=None)

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "schedule solve job not found"):
                main._claim_schedule_solve_job_sync(solve_payload(), "job-1", retry_count=0, execution_token=EXECUTION_TOKEN)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "ScheduleSolveJob"', sql_text)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_schedule_solve_job_claim_rejects_nonterminal_non_entitled_tenants_after_provenance(self):
        for tenant_status in ("TRIAL", "PAST_DUE", "SUSPENDED", "CANCELLED", "PURGED"):
            with self.subTest(tenant_status=tenant_status):
                fake_connection = FakePersistenceConnection(tenant_status=tenant_status)

                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}):
                    with patch.dict(
                        sys.modules,
                        {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)},
                    ):
                        with self.assertRaisesRegex(main.NonRetryableJobError, "active paid subscription"):
                            main._claim_schedule_solve_job_sync(solve_payload(), "job-1", retry_count=0, execution_token=EXECUTION_TOKEN)

                sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
                self.assertIn('FROM "Tenant"', sql_text)
                self.assertIn("FOR UPDATE", sql_text)
                self.assertIn('FROM "ScheduleSolveJob"', sql_text)
                self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_schedule_solve_job_claim_rejects_active_tenant_without_subscription(self):
        fake_connection = FakePersistenceConnection(tenant_subscription_id=None)

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "active paid subscription"):
                main._claim_schedule_solve_job_sync(
                    solve_payload(), "job-1", retry_count=0, execution_token=EXECUTION_TOKEN
                )

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "ScheduleSolveJob"', sql_text)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_schedule_solve_job_claim_rejects_free_null_or_past_paid_through_state(self):
        cases = [
            ("free", "FREE", True),
            ("null_period_end", "GROWTH", None),
            ("past_period_end", "GROWTH", False),
        ]
        for case, tenant_plan, period_current in cases:
            with self.subTest(
                case=case,
                tenant_plan=tenant_plan,
                period_current=period_current,
            ):
                fake_connection = FakePersistenceConnection(
                    tenant_plan=tenant_plan,
                    tenant_subscription_period_current=period_current,
                )
                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                        patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
                    with self.assertRaisesRegex(main.NonRetryableJobError, "active paid subscription"):
                        main._claim_schedule_solve_job_sync(
                            solve_payload(),
                            "job-1",
                            retry_count=0,
                            execution_token=EXECUTION_TOKEN,
                        )

                sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
                self.assertIn('"planTier"', sql_text)
                self.assertIn('"stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP', sql_text)
                self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_schedule_solve_job_claim_rejects_missing_paid_credit_reservation(self):
        fake_connection = FakePersistenceConnection(
            schedule_job_has_paid_credit_reservation=False,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.ScheduleCreditProvenanceError, "debit provenance"):
                main._claim_schedule_solve_job_sync(
                    solve_payload(), "job-1", retry_count=0, execution_token=EXECUTION_TOKEN
                )

        claim_sql = next(
            sql for sql, _ in fake_connection.cursor_obj.calls
            if 'FROM "ScheduleSolveJob"' in sql
        )
        self.assertIn('FROM "CreditTransaction" credit', claim_sql)
        self.assertIn('MIN(credit."reason")', claim_sql)
        self.assertIn('schedule-credit-refund-', claim_sql)
        self.assertIn('credit."debtAmount" = 0', claim_sql)
        self.assertIn('credit."debtAfter" = 0', claim_sql)
        self.assertIn('refund."amount"::BIGINT - refund."debtAmount"::BIGINT', claim_sql)
        self.assertFalse(any(
            sql.startswith('UPDATE "ScheduleSolveJob"')
            for sql, _ in fake_connection.cursor_obj.calls
        ))

    def test_schedule_solve_job_claim_rejects_debit_without_matching_post_debit_balance(self):
        fake_connection = FakePersistenceConnection(
            schedule_job_debit_balance_after=4,
        )
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.ScheduleCreditProvenanceError, "debit provenance"):
                main._claim_schedule_solve_job_sync(
                    solve_payload(),
                    "job-1",
                    retry_count=0,
                    execution_token=EXECUTION_TOKEN,
                )

        self.assertFalse(any(
            sql.startswith('UPDATE "ScheduleSolveJob"')
            for sql, _ in fake_connection.cursor_obj.calls
        ))

    def test_schedule_solve_terminal_replay_validates_provenance_before_skipping(self):
        valid = FakePersistenceConnection(
            schedule_job_status="FAILED",
            tenant_status="PAST_DUE",
        )
        invalid = FakePersistenceConnection(
            schedule_job_status="FAILED",
            schedule_job_has_paid_credit_reservation=False,
            tenant_status="CANCELLED",
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: valid)}):
            self.assertEqual(
                main._claim_schedule_solve_job_sync(
                    solve_payload(), "job-1", retry_count=0, execution_token=EXECUTION_TOKEN
                ),
                "terminal",
            )
        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: invalid)}):
            with self.assertRaisesRegex(main.ScheduleCreditProvenanceError, "debit provenance"):
                main._claim_schedule_solve_job_sync(
                    solve_payload(), "job-1", retry_count=0, execution_token=EXECUTION_TOKEN
                )

        valid_sql = "\n".join(sql for sql, _ in valid.cursor_obj.calls)
        self.assertIn('FROM "Tenant"', valid_sql)
        self.assertIn('FROM "ScheduleSolveJob"', valid_sql)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', valid_sql)
        invalid_sql = "\n".join(sql for sql, _ in invalid.cursor_obj.calls)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', invalid_sql)

    def test_succeeded_terminal_replay_skips_after_paid_entitlement_is_lost(self):
        for tenant_status in ("PAST_DUE", "CANCELLED"):
            with self.subTest(tenant_status=tenant_status):
                fake_connection = FakePersistenceConnection(
                    schedule_job_status="SUCCEEDED",
                    tenant_status=tenant_status,
                    tenant_subscription_id=None,
                )

                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                        patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
                    self.assertEqual(
                        main._claim_schedule_solve_job_sync(
                            solve_payload(),
                            "job-1",
                            retry_count=0,
                            execution_token=EXECUTION_TOKEN,
                        ),
                        "terminal",
                    )

                statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
                tenant_lock_index = next(
                    index for index, sql in enumerate(statements) if 'FROM "Tenant"' in sql
                )
                job_lock_index = next(
                    index for index, sql in enumerate(statements) if 'FROM "ScheduleSolveJob"' in sql
                )
                self.assertLess(tenant_lock_index, job_lock_index)
                self.assertFalse(any(
                    sql.startswith(("INSERT ", "UPDATE ", "DELETE "))
                    for sql in statements
                ))

    def test_schedule_solve_job_claim_reports_an_active_owner_as_busy(self):
        fake_connection = FakePersistenceConnection(
            schedule_job_status="RUNNING",
            schedule_job_execution_token="b" * 32,
            schedule_job_lease_active=True,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            claimed = main._claim_schedule_solve_job_sync(
                solve_payload(),
                "job-1",
                retry_count=0,
                execution_token=EXECUTION_TOKEN,
            )

        self.assertEqual(claimed, "busy")
        self.assertFalse(any(
            sql.startswith('UPDATE "ScheduleSolveJob"')
            for sql, _ in fake_connection.cursor_obj.calls
        ))

    def test_schedule_solve_job_claim_takes_over_an_expired_owner(self):
        fake_connection = FakePersistenceConnection(
            schedule_job_status="RUNNING",
            schedule_job_execution_token="b" * 32,
            schedule_job_lease_active=False,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            claimed = main._claim_schedule_solve_job_sync(
                solve_payload(),
                "job-1",
                retry_count=1,
                execution_token=EXECUTION_TOKEN,
            )

        self.assertEqual(claimed, "claimed")
        update_params = next(
            params for sql, params in fake_connection.cursor_obj.calls
            if sql.startswith('UPDATE "ScheduleSolveJob"')
        )
        self.assertEqual(update_params[1], EXECUTION_TOKEN)

    def test_persist_discards_a_stale_execution_owner_before_shift_writes(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(
            schedule_job_status="RUNNING",
            schedule_job_execution_token="b" * 32,
            schedule_job_lease_active=True,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaises(main.ScheduleJobOwnershipLostError):
                main._persist_solved_schedule_sync(
                    payload,
                    normalized,
                    "job-1",
                    execution_token=EXECUTION_TOKEN,
                )

        self.assertFalse(any(
            'INSERT INTO "Shift"' in sql
            for sql, _ in fake_connection.cursor_obj.calls
        ))

    def test_persist_revalidates_debit_balance_before_shift_or_revision_writes(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(
            schedule_job_debit_balance_after=4,
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "debit provenance"):
                main._persist_solved_schedule_sync(
                    payload,
                    normalized,
                    "job-1",
                    execution_token=EXECUTION_TOKEN,
                )

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertNotIn('FROM "Shift"', sql_text)
        self.assertNotIn('UPDATE "Schedule"', sql_text)

    def test_schedule_solve_job_success_marks_terminal_with_shift_count(self):
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._update_schedule_solve_job_status_sync(
                solve_payload(),
                "job-1",
                "SUCCEEDED",
                None,
                retry_count=1,
                result_shift_count=8,
            )

        update_params = next(params for sql, params in fake_connection.cursor_obj.calls if 'UPDATE "ScheduleSolveJob"' in sql)
        self.assertEqual(update_params[0], "SUCCEEDED")
        self.assertIsNone(update_params[1])
        self.assertEqual(update_params[2], 1)
        self.assertEqual(update_params[3], 8)
        self.assertTrue(update_params[4])

    def test_schedule_status_storage_collapses_raw_reasons_to_internal_code(self):
        fake_connection = FakePersistenceConnection()
        raw_reason = (
            "Traceback at /srv/worker/main.py: postgresql://worker:super-secret@db.internal/tenant-42"
            "?token=secret-token"
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._update_schedule_solve_job_status_sync(
                solve_payload(),
                "job-1",
                "RETRYING",
                raw_reason,
                retry_count=2,
                result_shift_count=None,
            )

        update_params = next(
            params for sql, params in fake_connection.cursor_obj.calls
            if 'UPDATE "ScheduleSolveJob"' in sql
        )
        self.assertEqual(update_params[1], main.INTERNAL_JOB_STATUS_REASON)
        serialized = repr(update_params)
        for sensitive in ("super-secret", "db.internal", "tenant-42", "secret-token", "/srv/worker"):
            self.assertNotIn(sensitive, serialized)
    def test_retrying_status_refreshes_confirmed_outbox_ownership(self):
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._update_schedule_solve_job_status_sync(
                solve_payload(),
                "job-1",
                "RETRYING",
                "temporary",
                retry_count=2,
                result_shift_count=None,
            )

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('"publicationStatus" = CASE WHEN %s THEN \'PUBLISHED\'', sql_text)
        self.assertIn('"publishedAt" = CASE WHEN %s THEN CURRENT_TIMESTAMP', sql_text)
        update_params = next(params for sql, params in fake_connection.cursor_obj.calls if 'UPDATE "ScheduleSolveJob"' in sql)
        self.assertEqual(update_params[5:9], (True, True, True, True))

    def test_authoritative_terminal_settlement_resolves_identity_then_locks_tenant_before_job(self):
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {
            "DATABASE_URL": "postgresql://unit-test",
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET": "unit-test-platform-capability",
        }), patch.dict(
            sys.modules,
            {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)},
        ):
            main._terminalize_schedule_solve_job_by_id_sync(
                "job-1",
                "DEAD_LETTERED",
                "WORKER_FAILURE_NON_RETRYABLE_JOB",
                retry_count=main.MAX_RETRIES,
            )

        statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
        platform_index = next(
            index for index, sql in enumerate(statements)
            if sql.startswith("SELECT set_current_platform_admin")
        )
        identity_index = next(
            index for index, sql in enumerate(statements)
            if sql.startswith('SELECT "tenantId", "scheduleId", "locationId"')
        )
        tenant_lock_index = next(
            index for index, sql in enumerate(statements)
            if 'FROM "Tenant"' in sql
        )
        job_lock_index = next(
            index for index, sql in enumerate(statements)
            if sql.startswith("WITH locked_job AS MATERIALIZED")
        )
        self.assertLess(platform_index, identity_index)
        self.assertLess(identity_index, tenant_lock_index)
        self.assertLess(tenant_lock_index, job_lock_index)
        terminal_params = fake_connection.cursor_obj.calls[job_lock_index][1]
        self.assertEqual(terminal_params[:8], (
            "job-1",
            "tenant-1",
            "sch-1",
            "loc-1",
            "schedule-credit-refund-job-1",
            "DEAD_LETTERED",
            "WORKER_FAILURE_NON_RETRYABLE_JOB",
            main.MAX_RETRIES,
        ))
        self.assertEqual(terminal_params[9:11], (None, None))

    def test_terminal_failure_refunds_wallet_credit_once_with_a_ledger_entry(self):
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            main._update_schedule_solve_job_status_sync(
                solve_payload(),
                "job-1",
                "DEAD_LETTERED",
                "solver unavailable",
                retry_count=3,
                result_shift_count=None,
            )

        statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
        tenant_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "Tenant"' in sql)
        job_update_index = next(index for index, sql in enumerate(statements) if 'UPDATE "ScheduleSolveJob"' in sql)
        self.assertLess(tenant_lock_index, job_update_index)
        sql_text, update_params = next(
            (sql, params) for sql, params in fake_connection.cursor_obj.calls
            if sql.startswith('WITH locked_job AS MATERIALIZED')
        )
        self.assertIn('FROM "ScheduleSolveJob" job', sql_text)
        self.assertIn('JOIN debit_rows debit ON TRUE', sql_text)
        self.assertIn('debit."amount" = -job."configuredAmount"', sql_text)
        self.assertIn('debit."debtAmount" = 0', sql_text)
        self.assertIn('debit."debtAfter" = 0', sql_text)
        self.assertIn('debit."balanceAfter" =', sql_text)
        self.assertIn('public.settle_positive_credit_value', sql_text)
        self.assertIn('CROSS JOIN LATERAL', sql_text)
        self.assertIn('"status" NOT IN (\'SUCCEEDED\', \'FAILED\', \'DEAD_LETTERED\')', sql_text)
        self.assertNotIn('INSERT INTO "CreditTransaction"', sql_text)
        self.assertNotIn('UPDATE "Tenant" tenant', sql_text)
        self.assertEqual(update_params[4], "schedule-credit-refund-job-1")
        self.assertIsNone(update_params[9])
        self.assertIsNone(update_params[10])
        self.assertEqual(update_params[11], "Schedule generation refund (job-1)")
        self.assertEqual(update_params[12], "schedule-credit-refund-job-1")

    def test_terminal_failure_fails_closed_for_missing_mismatched_or_duplicate_debits(self):
        valid = [
            "QUEUED", {"source": "credits", "consumedCredits": 1, "newBalance": 0},
            1, "tenant-1", -1, "Schedule generation (job-1)", 0,
            0, None, None, None, None, 1, 1, 1, 1, 1,
        ]
        invalid_outcomes = []
        missing = valid.copy()
        missing[2:7] = [0, None, None, None, None]
        invalid_outcomes.append(missing)
        mismatched = valid.copy()
        mismatched[4] = -2
        invalid_outcomes.append(mismatched)
        duplicate = valid.copy()
        duplicate[2] = 2
        invalid_outcomes.append(duplicate)

        for outcome in invalid_outcomes:
            with self.subTest(outcome=outcome), self.assertRaisesRegex(
                main.RetryableJobError,
                "debit provenance",
            ):
                main._assert_schedule_refund_outcome(tuple(outcome), "tenant-1", "job-1")

    def test_terminal_failure_concurrent_retry_accepts_only_the_exact_existing_refund(self):
        settled = (
            "FAILED", {"source": "credits", "consumedCredits": 1, "newBalance": 0},
            1, "tenant-1", -1, "Schedule generation (job-1)", 0,
            1, "tenant-1", 1, "Schedule generation refund (job-1)", 9,
            0, 0, 0, None, None,
        )

        main._assert_schedule_refund_outcome(settled, "tenant-1", "job-1")
        main._assert_schedule_refund_outcome(settled, "tenant-1", "job-1")

        invalid_balance = list(settled)
        invalid_balance[11] = None
        with self.assertRaisesRegex(main.RetryableJobError, "refund provenance"):
            main._assert_schedule_refund_outcome(
                tuple(invalid_balance),
                "tenant-1",
                "job-1",
            )

    def test_terminal_failure_accepts_actual_refund_balance_after_same_tenant_intervening_grant(self):
        outcome = (
            "QUEUED", {"source": "credits", "consumedCredits": 1, "newBalance": 0},
            1, "tenant-1", -1, "Schedule generation (job-1)", 0,
            0, None, None, None, None,
            1, 1, 1, 1, 9,
        )

        main._assert_schedule_refund_outcome(outcome, "tenant-1", "job-1")

    def test_schedule_credit_provenance_rejects_wrong_reason_refund_coexistence_and_bad_balance(self):
        base = {
            "status": "RUNNING",
            "credit_consumption": {"source": "credits", "consumedCredits": 1, "newBalance": 0},
            "tenant_id": "tenant-1",
            "job_id": "job-1",
            "debit_count": 1,
            "debit_tenant_id": "tenant-1",
            "debit_amount": -1,
            "debit_reason": "Schedule generation (job-1)",
            "debit_balance_after": 0,
            "refund_count": 0,
            "refund_tenant_id": None,
            "refund_amount": None,
            "refund_reason": None,
            "refund_balance_after": None,
        }
        cases = [
            {"debit_reason": "Schedule generation"},
            {
                "refund_count": 1,
                "refund_tenant_id": "tenant-1",
                "refund_amount": 1,
                "refund_reason": "Schedule generation refund (job-1)",
            },
            {"credit_consumption": {"source": "credits", "consumedCredits": 1, "newBalance": -1}},
            {"credit_consumption": {"source": "credits", "consumedCredits": 1, "newBalance": 0, "extra": True}},
            {"debit_balance_after": 1},
        ]
        for overrides in cases:
            with self.subTest(overrides=overrides), self.assertRaises(main.RetryableJobError):
                main._assert_schedule_credit_provenance(**(base | overrides))

    def test_terminal_credit_metadata_sql_uses_exact_postgresql_object_reconstruction(self):
        source = Path(main.__file__).read_text(encoding="utf-8")

        self.assertIn('job."creditConsumption" = jsonb_build_object(', source)
        self.assertNotIn("jsonb_object_length", source)

    async def test_pdf_parse_errors_are_non_retryable(self):
        with patch.object(
            main,
            "process_availability_import",
            new=AsyncMock(side_effect=main.AvailabilityImportRejected("invalid document")),
        ):
            with self.assertRaises(main.NonRetryableJobError):
                await main.handle_pdf_job(
                    {"import_id": "import-1", "tenant_id": "tenant-1"}
                )
if __name__ == "__main__":
    unittest.main()
