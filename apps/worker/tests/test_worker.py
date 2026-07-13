import asyncio
from datetime import datetime, timezone
import json
import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import AsyncMock, patch

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

import main  # noqa: E402


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
    def __init__(self, fail_on_break_insert=False, schedule_job_status="QUEUED", schedule_revision=None,
                 shift_rows=None, location_active=True, location_timezone="UTC", tenant_status="ACTIVE"):
        self.calls = []
        self.fail_on_break_insert = fail_on_break_insert
        self.schedule_job_status = schedule_job_status
        self.schedule_revision = 0 if schedule_revision is None else schedule_revision
        self.shift_rows = list(shift_rows or [])
        self.location_active = location_active
        self.location_timezone = location_timezone
        self.tenant_status = tenant_status
        self.fetchone_result = None
        self.fetchall_result = []

    def __enter__(self):
        return self

    def __exit__(self, exc_type, exc, traceback):
        return False

    def execute(self, sql, params=None):
        compact_sql = " ".join(sql.split())
        self.calls.append((compact_sql, params))
        if 'FROM "Tenant"' in compact_sql:
            self.fetchone_result = (self.tenant_status,) if self.tenant_status else None
        elif 'FROM "Location"' in compact_sql:
            self.fetchone_result = ("loc-1", self.location_timezone) if self.location_active else None
        elif 'FROM "ScheduleSolveJob"' in compact_sql:
            self.fetchone_result = (self.schedule_job_status,) if self.schedule_job_status else None
        elif 'FROM "Schedule"' in compact_sql:
            self.fetchone_result = ("sch-1", "DRAFT", self.schedule_revision)
        elif 'FROM "User"' in compact_sql:
            self.fetchall_result = [("u1",)]
        elif 'FROM "Shift"' in compact_sql and compact_sql.startswith("SELECT"):
            self.fetchall_result = self.shift_rows
        elif 'INSERT INTO "Break"' in compact_sql and self.fail_on_break_insert:
            raise RuntimeError("break insert failed")

    def fetchone(self):
        return self.fetchone_result

    def fetchall(self):
        return self.fetchall_result


class FakePersistenceConnection:
    def __init__(self, fail_on_break_insert=False, schedule_job_status="QUEUED", schedule_revision=None,
                 shift_rows=None, location_active=True, location_timezone="UTC", tenant_status="ACTIVE"):
        self.cursor_obj = FakePersistenceCursor(
            fail_on_break_insert=fail_on_break_insert,
            schedule_job_status=schedule_job_status,
            schedule_revision=schedule_revision,
            shift_rows=shift_rows,
            location_active=location_active,
            location_timezone=location_timezone,
            tenant_status=tenant_status,
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

        with patch.dict(main.JOB_HANDLERS, {"schedule.solve": handler}):
            first = await main.process_message(body, message_id="msg-1")
            duplicate = await main.process_message(body, message_id="msg-1")

        self.assertEqual(first, {"status": "SUCCESS"})
        self.assertEqual(duplicate, {"skipped": True})
        handler.assert_awaited_once()

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
            main._persist_solved_schedule_sync(solve_payload(), normalized, "job-1")

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

        with patch.object(main, "process_message", AsyncMock(side_effect=main.RetryableJobError("temporary"))), \
                patch.object(main, "try_mark_schedule_status_from_message", AsyncMock(side_effect=main.RetryableJobError("db unavailable"))), \
                patch.object(main.asyncio, "sleep", AsyncMock()) as sleep:
            await main.handle_queue_message(channel, message)

        sleep.assert_awaited_once_with(main.RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
        message.nack.assert_awaited_once_with(requeue=True)
        message.ack.assert_not_awaited()
        message.reject.assert_not_awaited()

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

    def test_solver_queue_depth_metric_reads_queue_declaration_count(self):
        queue = SimpleNamespace(declaration_result=SimpleNamespace(message_count=7))
        set_mock = patch.object(main.SOLVER_QUEUE_DEPTH, "set").start()
        self.addCleanup(patch.stopall)

        main.update_solver_queue_depth(queue)

        set_mock.assert_called_once_with(7)

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

        async def consume(_queue, _channel):
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

        async def consume(_queue, _channel):
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
            await main.run_worker_tasks(object(), object())

        self.assertTrue(sweep_cancelled.is_set())


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
            main._persist_solved_schedule_sync(payload, normalized, "job-1")

        statements = [sql for sql, _ in fake_connection.cursor_obj.calls]
        sql_text = "\n".join(statements)
        tenant_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "Tenant"' in sql)
        job_lock_index = next(index for index, sql in enumerate(statements) if 'FROM "ScheduleSolveJob"' in sql)
        self.assertLess(tenant_lock_index, job_lock_index)
        self.assertIn('FROM "Schedule"', sql_text)
        self.assertIn('"deletedAt" IS NULL', sql_text)
        self.assertIn("FOR UPDATE", sql_text)
        shift_insert = next(params for sql, params in fake_connection.cursor_obj.calls if 'INSERT INTO "Shift"' in sql)
        break_insert = next(params for sql, params in fake_connection.cursor_obj.calls if 'INSERT INTO "Break"' in sql)
        self.assertEqual(shift_insert[0], normalized[0].id)
        self.assertEqual(shift_insert[5], datetime(2026, 3, 9, 9, 0, tzinfo=timezone.utc))
        self.assertEqual(break_insert[1], normalized[0].id)
        self.assertEqual(break_insert[2], "LUNCH")
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
            main._persist_solved_schedule_sync(payload, normalized, "job-1")

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "ScheduleSolveJob"', sql_text)
        self.assertNotIn('INSERT INTO "Shift"', sql_text)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_persist_rejects_non_entitled_tenants_before_any_persistence_write(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))

        for tenant_status in ("PAST_DUE", "SUSPENDED", "CANCELLED", "PURGED"):
            with self.subTest(tenant_status=tenant_status):
                fake_connection = FakePersistenceConnection(tenant_status=tenant_status)

                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}):
                    with patch.dict(
                        sys.modules,
                        {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)},
                    ):
                        with self.assertRaisesRegex(main.NonRetryableJobError, "tenant is not active"):
                            main._persist_solved_schedule_sync(payload, normalized, "job-1")

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

    def test_persist_rejects_manual_shift_edits_after_queueing(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(
            shift_rows=[("manual-shift-1", datetime(2026, 3, 8, 21, 0))],
        )

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "draft shifts changed"):
                main._persist_solved_schedule_sync(payload, normalized, "job-1")

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
                main._persist_solved_schedule_sync(payload, normalized, "job-1")

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertNotIn('FROM "Shift"', sql_text)

    def test_persist_rejects_deleted_location_before_locking_or_writing_schedule(self):
        payload = solve_payload()
        normalized = main.normalize_solved_shifts(payload, solved_response(solved_shift()))
        fake_connection = FakePersistenceConnection(location_active=False)

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "location is not active"):
                main._persist_solved_schedule_sync(payload, normalized, "job-1")

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
                main._persist_solved_schedule_sync(payload, normalized, "job-1")

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
                main._persist_solved_schedule_sync(payload, normalized, "job-1")

        self.assertIs(fake_connection.exit_exc_type, RuntimeError)

    def test_schedule_solve_job_claim_marks_running(self):
        fake_connection = FakePersistenceConnection()

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            claimed = main._claim_schedule_solve_job_sync(solve_payload(), "job-1", retry_count=2)

        self.assertTrue(claimed)
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
        self.assertEqual(update_params[1], "job-1")

    def test_schedule_solve_job_claim_rejects_missing_durable_row(self):
        fake_connection = FakePersistenceConnection(schedule_job_status=None)

        with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}), \
                patch.dict(sys.modules, {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)}):
            with self.assertRaisesRegex(main.NonRetryableJobError, "schedule solve job not found"):
                main._claim_schedule_solve_job_sync(solve_payload(), "job-1", retry_count=0)

        sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
        self.assertIn('FROM "ScheduleSolveJob"', sql_text)
        self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

    def test_schedule_solve_job_claim_rejects_non_entitled_tenants_before_job_lock(self):
        for tenant_status in ("PAST_DUE", "SUSPENDED", "CANCELLED", "PURGED"):
            with self.subTest(tenant_status=tenant_status):
                fake_connection = FakePersistenceConnection(tenant_status=tenant_status)

                with patch.dict(os.environ, {"DATABASE_URL": "postgresql://unit-test"}):
                    with patch.dict(
                        sys.modules,
                        {"psycopg": SimpleNamespace(connect=lambda _: fake_connection)},
                    ):
                        with self.assertRaisesRegex(main.NonRetryableJobError, "tenant is not active"):
                            main._claim_schedule_solve_job_sync(solve_payload(), "job-1", retry_count=0)

                sql_text = "\n".join(sql for sql, _ in fake_connection.cursor_obj.calls)
                self.assertIn('FROM "Tenant"', sql_text)
                self.assertIn("FOR UPDATE", sql_text)
                self.assertNotIn('FROM "ScheduleSolveJob"', sql_text)
                self.assertNotIn('UPDATE "ScheduleSolveJob"', sql_text)

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
            if 'UPDATE "ScheduleSolveJob"' in sql
        )
        self.assertTrue(sql_text.startswith('WITH updated_job AS ( UPDATE "ScheduleSolveJob"'))
        self.assertIn('RETURNING "tenantId", "creditConsumption" ), inserted_refund AS (', sql_text)
        self.assertIn('FROM updated_job', sql_text)
        self.assertIn('"status" NOT IN (\'SUCCEEDED\', \'FAILED\', \'DEAD_LETTERED\')', sql_text)
        self.assertIn('INSERT INTO "CreditTransaction"', sql_text)
        self.assertIn('ON CONFLICT ("id") DO NOTHING', sql_text)
        self.assertIn('UPDATE "Tenant" tenant', sql_text)
        self.assertEqual(update_params[12], "schedule-credit-refund-job-1")
        self.assertEqual(update_params[13], "Schedule generation refund (job-1)")
        self.assertTrue(update_params[14])

    async def test_pdf_parse_errors_are_non_retryable(self):
        from src.parser.pdf_parser import AvailabilityParseError

        with patch(
            "src.parser.pdf_parser.AvailabilityParser.parse_document",
            side_effect=AvailabilityParseError("no readable text found in availability PDF"),
        ):
            with self.assertRaises(main.NonRetryableJobError):
                await main.handle_pdf_job({"action": "parse", "file_path": "availability.pdf"})


if __name__ == "__main__":
    unittest.main()
