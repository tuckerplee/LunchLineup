"""
RabbitMQ background worker.

Consumes durable job messages, validates payloads at the queue boundary, and
delegates schedule solves to the engine with bounded retries and deadlines.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass
from datetime import date, datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import time
from typing import Any, Awaitable, Callable
import uuid
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

import grpc
from opentelemetry import trace
from prometheus_client import Counter, Gauge, Histogram, start_http_server
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator, model_validator
from src.billing_usage import (
    NonRetryableBillingError,
    RetryableBillingError,
    dispatch_usage,
    metered_usage_enabled,
    run_billing_usage_loop,
    validate_billing_runtime_config,
)
from src.telemetry import configure_tracing, current_trace_metadata
from src.password_reset_email import (
    NonRetryableEmailError,
    RetryableEmailError,
    dispatch_password_reset_email,
    password_reset_email_enabled,
    run_password_reset_email_loop,
    validate_password_reset_email_config,
)

configure_tracing("lunchlineup-worker")
TRACER = trace.get_tracer("lunchlineup.worker")

logger = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

ID_PATTERN = r"^[A-Za-z0-9._:@+-]{1,128}$"
SOLVER_CONSTRAINTS = {
    "availability",
    "break_rules",
    "daily_demand",
    "max_hours_per_week",
    "min_floor_coverage",
    "shift_duration_hours",
    "skill_requirements",
    "solver_time_limit_seconds",
    "staff_skills",
    "timezone",
}


def int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def float_env(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


ENVIRONMENT = os.getenv("ENVIRONMENT", os.getenv("NODE_ENV", "development")).lower()
RABBITMQ_URL = os.getenv("RABBITMQ_URL", "amqp://localhost:5672")
ENGINE_GRPC_URL = os.getenv("ENGINE_GRPC_URL", "localhost:50051")
ENGINE_GRPC_TIMEOUT_SECONDS = float_env("ENGINE_GRPC_TIMEOUT_SECONDS", 20.0, 1.0, 60.0)
MAX_RETRIES = int_env("WORKER_MAX_RETRIES", 3, 0, 10)
MAX_MESSAGE_BYTES = int_env("WORKER_MAX_MESSAGE_BYTES", 262_144, 4_096, 1_048_576)
MAX_STAFF_IDS = int_env("WORKER_MAX_STAFF_IDS", 200, 1, 500)
QUEUE_NAME = os.getenv("WORKER_QUEUE_NAME", "lunchlineup.jobs")
DLQ_NAME = os.getenv("WORKER_DLQ_NAME", "lunchlineup.jobs.dlq")
RETRY_QUEUE_PREFIX = os.getenv("WORKER_RETRY_QUEUE_PREFIX", f"{QUEUE_NAME}.retry")
RETRY_BACKOFF_SECONDS = [int_env("WORKER_RETRY_BACKOFF_1_SECONDS", 5, 1, 300),
                         int_env("WORKER_RETRY_BACKOFF_2_SECONDS", 30, 1, 900),
                         int_env("WORKER_RETRY_BACKOFF_3_SECONDS", 120, 1, 3600)]
RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS = int_env(
    "WORKER_RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS", 5, 1, 30
)
SOLVE_SUCCESS_STATUS = "SUCCESS"
SCHEDULE_JOB_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "DEAD_LETTERED"}
SCHEDULING_TENANT_STATUSES = {"ACTIVE", "TRIAL"}
SCHEDULABLE_DB_ROLES = ("MANAGER", "STAFF")
SHIFT_ROLE_MAX_LENGTH = 64
BREAK_TYPE_ALIASES = {
    "": "LUNCH",
    "MEAL": "LUNCH",
    "LUNCH": "LUNCH",
    "BREAK1": "BREAK1",
    "FIRST_BREAK": "BREAK1",
    "REST": "BREAK1",
    "BREAK2": "BREAK2",
    "SECOND_BREAK": "BREAK2",
}
_METRICS_STARTED = False
_COMPLETED_JOB_KEYS: OrderedDict[str, float] = OrderedDict()
_MAX_COMPLETED_KEYS = int_env("WORKER_IDEMPOTENCY_CACHE_SIZE", 10_000, 100, 100_000)

JOB_TOTAL = Counter("lunchlineup_worker_jobs_total", "Jobs processed by the worker", ["type", "status"])
JOB_RETRIES = Counter("lunchlineup_worker_job_retries_total", "Jobs republished for retry", ["type"])
JOB_DURATION = Histogram(
    "lunchlineup_worker_job_duration_seconds",
    "Time spent processing worker jobs",
    ["type"],
    buckets=[0.05, 0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0],
)
IN_FLIGHT_JOBS = Gauge("lunchlineup_worker_in_flight_jobs", "Jobs currently being processed by this worker")
SOLVER_QUEUE_DEPTH = Gauge("lunchlineup_solver_queue_depth", "Pending jobs in the schedule solver queue")


class RetryableJobError(RuntimeError):
    pass


class NonRetryableJobError(RuntimeError):
    pass


def lock_tenant_status(cursor: Any, tenant_id: str) -> str | None:
    cursor.execute(
        'SELECT "status" FROM "Tenant" WHERE "id" = %s FOR UPDATE',
        (tenant_id,),
    )
    tenant = cursor.fetchone()
    return str(tenant[0]) if tenant else None


def lock_scheduling_tenant(cursor: Any, tenant_id: str) -> None:
    if lock_tenant_status(cursor, tenant_id) not in SCHEDULING_TENANT_STATUSES:
        raise NonRetryableJobError("tenant is not active for schedule solving")


@dataclass
class NormalizedBreak:
    id: str
    start_time: datetime
    end_time: datetime
    paid: bool
    break_type: str


@dataclass
class NormalizedShift:
    id: str
    staff_id: str
    start_time: datetime
    end_time: datetime
    role: str
    breaks: list[NormalizedBreak]


class AvailabilityRule(BaseModel):
    model_config = ConfigDict(extra="forbid")

    day_of_week: str = Field(..., min_length=1, max_length=16)
    start_time: str = Field(..., min_length=4, max_length=8)
    end_time: str = Field(..., min_length=4, max_length=8)


class DemandWindow(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    start_time: str = Field(..., min_length=8, max_length=40)
    end_time: str = Field(..., min_length=8, max_length=40)
    required_staff: int = Field(..., ge=1, le=MAX_STAFF_IDS)
    skill: str | None = Field(default=None, max_length=128)


class ExistingShift(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    staff_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    location_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    start_time: str = Field(..., min_length=8, max_length=40)
    end_time: str = Field(..., min_length=8, max_length=40)


class DraftShiftSnapshotEntry(BaseModel):
    model_config = ConfigDict(extra="forbid")

    id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    updated_at: str = Field(..., min_length=8, max_length=40)


class SolvePayload(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schedule_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    tenant_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    location_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    start_date: str = Field(..., min_length=8, max_length=40)
    end_date: str = Field(..., min_length=8, max_length=40)
    draft_revision: int = Field(..., ge=0)
    input_shift_snapshot: list[DraftShiftSnapshotEntry] = Field(default_factory=list, max_length=10_000)
    staff_ids: list[str] = Field(..., min_length=1)
    constraints: dict[str, Any] = Field(default_factory=dict)
    availability: dict[str, list[AvailabilityRule]] = Field(default_factory=dict)
    availability_configured: dict[str, bool] = Field(default_factory=dict)
    staff_skills: dict[str, list[str]] = Field(default_factory=dict)
    skill_requirements: dict[str, Any] = Field(default_factory=dict)
    daily_demand: Any = Field(default=None)
    demand_windows: list[DemandWindow] = Field(default_factory=list, max_length=500)
    timezone: str = Field(default="UTC", min_length=1, max_length=128)
    existing_weekly_minutes: dict[str, dict[str, int]] = Field(default_factory=dict)
    existing_shifts: list[ExistingShift] = Field(default_factory=list, max_length=10_000)

    @field_validator("staff_ids")
    @classmethod
    def validate_staff_ids(cls, value: list[str]) -> list[str]:
        if len(value) > MAX_STAFF_IDS:
            raise ValueError(f"staff_ids cannot exceed {MAX_STAFF_IDS}")
        normalized = []
        seen = set()
        for staff_id in value:
            if not isinstance(staff_id, str):
                raise ValueError("staff_ids must contain strings")
            trimmed = staff_id.strip()
            if not trimmed or len(trimmed) > 128:
                raise ValueError("staff_ids contain an invalid identifier")
            if trimmed not in seen:
                normalized.append(trimmed)
                seen.add(trimmed)
        return normalized

    @field_validator("constraints")
    @classmethod
    def validate_constraints(cls, value: dict[str, Any]) -> dict[str, Any]:
        unknown = set(value) - SOLVER_CONSTRAINTS
        if unknown:
            raise ValueError(f"Unsupported constraint: {sorted(unknown)[0]}")
        if len(value) > 20:
            raise ValueError("constraints cannot exceed 20 entries")
        if len(json.dumps(value, separators=(",", ":"))) > 16_384:
            raise ValueError("constraints payload is too large")
        return value

    @model_validator(mode="after")
    def validate_availability_staff(self) -> "SolvePayload":
        unknown_staff = set(self.availability) - set(self.staff_ids)
        if unknown_staff:
            raise ValueError("availability includes staff outside staff_ids")
        unknown_configured_staff = set(self.availability_configured) - set(self.staff_ids)
        if unknown_configured_staff:
            raise ValueError("availability_configured includes staff outside staff_ids")
        unknown_skill_staff = set(self.staff_skills) - set(self.staff_ids)
        if unknown_skill_staff:
            raise ValueError("staff_skills includes staff outside staff_ids")
        unknown_hours_staff = set(self.existing_weekly_minutes) - set(self.staff_ids)
        if unknown_hours_staff:
            raise ValueError("existing_weekly_minutes includes staff outside staff_ids")
        for shift in self.existing_shifts:
            if shift.staff_id not in self.staff_ids:
                raise ValueError("existing_shifts includes staff outside staff_ids")
            shift_start = parse_iso_datetime(shift.start_time, "existing_shifts.start_time", require_time=True)
            shift_end = parse_iso_datetime(shift.end_time, "existing_shifts.end_time", require_time=True)
            if shift_end <= shift_start:
                raise ValueError("existing_shifts end_time must be after start_time")
            if shift_start >= parse_iso_datetime(self.end_date, "end_date") or shift_end <= parse_iso_datetime(self.start_date, "start_date"):
                raise ValueError("existing_shifts must overlap the schedule window")
        if self.staff_skills and "staff_skills" in self.constraints:
            raise ValueError("staff_skills cannot be supplied in both staff_skills and constraints")
        if self.skill_requirements and "skill_requirements" in self.constraints:
            raise ValueError("skill_requirements cannot be supplied in both skill_requirements and constraints")
        if self.daily_demand is not None and "daily_demand" in self.constraints:
            raise ValueError("daily_demand cannot be supplied in both daily_demand and constraints")
        start_date = parse_iso_datetime(self.start_date, "start_date")
        end_date = parse_iso_datetime(self.end_date, "end_date")
        if end_date <= start_date:
            raise ValueError("end_date must be after start_date")
        shift_ids = [entry.id for entry in self.input_shift_snapshot]
        if len(shift_ids) != len(set(shift_ids)):
            raise ValueError("input_shift_snapshot contains duplicate shift ids")
        for entry in self.input_shift_snapshot:
            parse_iso_datetime(entry.updated_at, "input_shift_snapshot.updated_at", require_time=True)
        for window in self.demand_windows:
            window_start = parse_iso_datetime(window.start_time, "demand_windows.start_time", require_time=True)
            window_end = parse_iso_datetime(window.end_time, "demand_windows.end_time", require_time=True)
            if not (start_date <= window_start < window_end <= end_date):
                raise ValueError("demand window must be inside the schedule window")
        for weekly_minutes in self.existing_weekly_minutes.values():
            if len(weekly_minutes) > 6:
                raise ValueError("existing_weekly_minutes cannot exceed 6 weeks per staff member")
            for week_start, minutes in weekly_minutes.items():
                try:
                    parsed_week = date.fromisoformat(week_start)
                except (TypeError, ValueError) as exc:
                    raise ValueError("existing_weekly_minutes keys must be ISO Monday dates") from exc
                if parsed_week.weekday() != 0:
                    raise ValueError("existing_weekly_minutes keys must be ISO Monday dates")
                if isinstance(minutes, bool) or not isinstance(minutes, int) or not 0 <= minutes <= 10_080:
                    raise ValueError("existing_weekly_minutes values must be whole minutes from 0 to 10080")
        try:
            ZoneInfo(self.timezone)
        except (ZoneInfoNotFoundError, ValueError) as exc:
            raise ValueError("timezone must be a valid IANA timezone") from exc
        return self


class JobMessage(BaseModel):
    model_config = ConfigDict(extra="ignore")

    type: str = Field(..., min_length=1, max_length=64)
    payload: dict[str, Any] = Field(default_factory=dict)
    retry_count: int = Field(default=0, ge=0, le=MAX_RETRIES)
    job_id: str | None = Field(default=None, min_length=1, max_length=128, pattern=ID_PATTERN)


async def handle_solve_job(
    payload: dict[str, Any],
    job_id: str | None = None,
    retry_count: int = 0,
) -> dict[str, Any]:
    """Delegate a validated scheduling job to the engine via gRPC."""
    solve_payload = validate_solve_payload(payload)
    schedule_ref = safe_ref(solve_payload.schedule_id)
    tenant_ref = safe_ref(solve_payload.tenant_id)
    logger.info("Processing solve job schedule_ref=%s tenant_ref=%s", schedule_ref, tenant_ref)

    solver_pb2, solver_pb2_grpc = load_solver_modules()
    request = solver_pb2.ScheduleRequest(
        schedule_id=solve_payload.schedule_id,
        tenant_id=solve_payload.tenant_id,
        location_id=solve_payload.location_id,
        start_date=solve_payload.start_date,
        end_date=solve_payload.end_date,
    )

    for staff_id in solve_payload.staff_ids:
        staff_member = request.staff.add()
        staff_member.id = staff_id
        staff_member.availability_configured = solve_payload.availability_configured.get(
            staff_id,
            bool(solve_payload.availability.get(staff_id)),
        )
        if hasattr(staff_member, "skills"):
            staff_member.skills.extend(solve_payload.staff_skills.get(staff_id, []))
        for slot in solve_payload.availability.get(staff_id, []):
            availability = staff_member.availability.add()
            availability.day_of_week = slot.day_of_week
            availability.start_time = slot.start_time
            availability.end_time = slot.end_time

    for staff_id, weekly_minutes in solve_payload.existing_weekly_minutes.items():
        for week_start_date, minutes in weekly_minutes.items():
            existing = request.existing_weekly_minutes.add()
            existing.staff_id = staff_id
            existing.week_start_date = week_start_date
            existing.minutes = minutes

    for shift in solve_payload.existing_shifts:
        existing_shift = request.existing_shifts.add()
        existing_shift.id = shift.id
        existing_shift.staff_id = shift.staff_id
        existing_shift.location_id = shift.location_id
        existing_shift.start_time = shift.start_time
        existing_shift.end_time = shift.end_time

    constraints = dict(solve_payload.constraints)
    constraints["timezone"] = solve_payload.timezone
    if solve_payload.skill_requirements:
        constraints["skill_requirements"] = solve_payload.skill_requirements
    if solve_payload.daily_demand is not None:
        constraints["daily_demand"] = solve_payload.daily_demand
    if solve_payload.demand_windows:
        constraints["demand_windows"] = [window.model_dump() for window in solve_payload.demand_windows]

    for key, value in constraints.items():
        if key == "availability":
            raise NonRetryableJobError("availability must be supplied in the availability field")
        constraint = request.constraints.add()
        constraint.type = key
        constraint.value = value if isinstance(value, str) else json.dumps(value, separators=(",", ":"))

    response = await calculate_schedule(request, solver_pb2_grpc)

    if str(getattr(response, "status", "")).upper() != SOLVE_SUCCESS_STATUS:
        reason = solve_failure_reason(response)
        raise NonRetryableJobError(f"engine solve failed: {reason}")
    if response.schedule_id != solve_payload.schedule_id:
        raise RetryableJobError("engine returned a mismatched schedule id")

    solved_shifts = normalize_solved_shifts(solve_payload, response)
    validate_solved_demand_coverage(solve_payload, solved_shifts)
    await persist_solved_schedule(solve_payload, solved_shifts, job_id, retry_count)
    logger.info("Solve complete schedule_ref=%s shifts=%s", schedule_ref, len(solved_shifts))
    return {"status": response.status, "schedule_id": response.schedule_id, "shift_count": len(solved_shifts)}


async def calculate_schedule(request: Any, solver_pb2_grpc: Any) -> Any:
    try:
        async with grpc.aio.insecure_channel(ENGINE_GRPC_URL) as channel:
            stub = solver_pb2_grpc.SolverServiceStub(channel)
            return await stub.CalculateSchedule(
                request,
                timeout=ENGINE_GRPC_TIMEOUT_SECONDS,
                metadata=current_trace_metadata(),
            )
    except grpc.aio.AioRpcError as exc:
        raise RetryableJobError(f"engine rpc failed: {exc.code().name}") from exc


def solve_failure_reason(response: Any) -> str:
    reason = getattr(response, "reason", "") or "engine returned a failed solve response"
    details = list(getattr(response, "infeasible_details", []) or [])
    if not details:
        return reason
    first = details[0]
    parts = [str(getattr(first, "code", "") or "infeasible")]
    date = str(getattr(first, "date", "") or "")
    skill = str(getattr(first, "skill", "") or "")
    required = int(getattr(first, "required", 0) or 0)
    available = int(getattr(first, "available", 0) or 0)
    if date:
        parts.append(f"date={date}")
    if skill:
        parts.append(f"skill={skill}")
    if required or available:
        parts.append(f"required={required}")
        parts.append(f"available={available}")
    return f"{reason} ({', '.join(parts)})"


async def persist_solved_schedule(
    solve_payload: SolvePayload,
    solved_shifts: list[NormalizedShift],
    job_id: str | None,
    retry_count: int,
) -> None:
    await asyncio.to_thread(_persist_solved_schedule_sync, solve_payload, solved_shifts, job_id, retry_count)


def _persist_solved_schedule_sync(
    solve_payload: SolvePayload,
    solved_shifts: list[NormalizedShift],
    job_id: str | None,
    retry_count: int = 0,
) -> None:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        raise RetryableJobError("DATABASE_URL is required to persist solved schedules")
    if not job_id:
        raise NonRetryableJobError("schedule solve job id is required for atomic persistence")

    try:
        import psycopg
    except ImportError as exc:
        raise RetryableJobError("psycopg is required to persist solved schedules") from exc

    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (solve_payload.tenant_id,))
                lock_scheduling_tenant(cursor, solve_payload.tenant_id)
                cursor.execute(
                    'SELECT id, timezone FROM "Location" WHERE id = %s AND "tenantId" = %s AND "deletedAt" IS NULL FOR UPDATE',
                    (solve_payload.location_id, solve_payload.tenant_id),
                )
                location = cursor.fetchone()
                if not location:
                    raise NonRetryableJobError("location is not active for this tenant")
                if str(location[1]) != solve_payload.timezone:
                    raise NonRetryableJobError("location timezone changed after the solve job was queued")

                cursor.execute(
                    'SELECT id, status, revision FROM "Schedule" WHERE id = %s AND "tenantId" = %s AND "locationId" = %s AND "deletedAt" IS NULL FOR UPDATE',
                    (solve_payload.schedule_id, solve_payload.tenant_id, solve_payload.location_id),
                )
                schedule = cursor.fetchone()
                if not schedule:
                    raise NonRetryableJobError("schedule is not available for this tenant")
                if schedule[1] != "DRAFT":
                    raise NonRetryableJobError("only draft schedules can receive solved shifts")
                if int(schedule[2]) != solve_payload.draft_revision:
                    raise NonRetryableJobError("draft changed after the solve job was queued")

                cursor.execute(
                    '''
                    SELECT "status"
                    FROM "ScheduleSolveJob"
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                    FOR UPDATE
                    ''',
                    (job_id, solve_payload.tenant_id, solve_payload.schedule_id),
                )
                job = cursor.fetchone()
                if not job:
                    raise NonRetryableJobError("schedule solve job not found")
                if str(job[0]) == "SUCCEEDED":
                    return
                if str(job[0]) in {"FAILED", "DEAD_LETTERED"}:
                    raise NonRetryableJobError("schedule solve job is already terminal")

                cursor.execute(
                    'SELECT id FROM "User" WHERE "tenantId" = %s AND "deletedAt" IS NULL AND role = ANY(%s::"UserRole"[]) AND id = ANY(%s)',
                    (solve_payload.tenant_id, list(SCHEDULABLE_DB_ROLES), solve_payload.staff_ids),
                )
                known_staff = {row[0] for row in cursor.fetchall()}
                missing_staff = set(solve_payload.staff_ids) - known_staff
                if missing_staff:
                    raise NonRetryableJobError("solve response includes staff outside the tenant")

                cursor.execute(
                    'SELECT id, "updatedAt" FROM "Shift" WHERE "tenantId" = %s AND "scheduleId" = %s AND "deletedAt" IS NULL ORDER BY id ASC FOR UPDATE',
                    (solve_payload.tenant_id, solve_payload.schedule_id),
                )
                existing_shift_rows = cursor.fetchall()
                current_shift_snapshot = [
                    (str(row[0]), revision_key(row[1]))
                    for row in existing_shift_rows
                ]
                expected_shift_snapshot = sorted(
                    (entry.id, revision_key(entry.updated_at))
                    for entry in solve_payload.input_shift_snapshot
                )
                if current_shift_snapshot != expected_shift_snapshot:
                    raise NonRetryableJobError("draft shifts changed after the solve job was queued")
                existing_shift_ids = [row[0] for row in existing_shift_rows]
                target_shift_ids = [shift.id for shift in solved_shifts]
                target_shift_id_set = set(target_shift_ids)
                stale_shift_ids = [shift_id for shift_id in existing_shift_ids if shift_id not in target_shift_id_set]

                if stale_shift_ids:
                    cursor.execute('DELETE FROM "Break" WHERE "shiftId" = ANY(%s)', (stale_shift_ids,))
                    cursor.execute(
                        'UPDATE "Shift" SET "deletedAt" = now(), "updatedAt" = now() WHERE id = ANY(%s)',
                        (stale_shift_ids,),
                    )

                if target_shift_ids:
                    cursor.execute('DELETE FROM "Break" WHERE "shiftId" = ANY(%s)', (target_shift_ids,))

                for solved_shift in solved_shifts:
                    if solved_shift.staff_id not in known_staff:
                        raise NonRetryableJobError("solve response includes staff outside the tenant")
                    cursor.execute(
                        '''
                        INSERT INTO "Shift"
                            ("id", "tenantId", "locationId", "scheduleId", "userId", "startTime", "endTime", "role", "createdAt", "updatedAt", "deletedAt")
                        VALUES (%s, %s, %s, %s, %s, %s, %s, %s, now(), now(), NULL)
                        ON CONFLICT ("id") DO UPDATE SET
                            "tenantId" = EXCLUDED."tenantId",
                            "locationId" = EXCLUDED."locationId",
                            "scheduleId" = EXCLUDED."scheduleId",
                            "userId" = EXCLUDED."userId",
                            "startTime" = EXCLUDED."startTime",
                            "endTime" = EXCLUDED."endTime",
                            "role" = EXCLUDED."role",
                            "updatedAt" = now(),
                            "deletedAt" = NULL
                        ''',
                        (
                            solved_shift.id,
                            solve_payload.tenant_id,
                            solve_payload.location_id,
                            solve_payload.schedule_id,
                            solved_shift.staff_id,
                            solved_shift.start_time,
                            solved_shift.end_time,
                            solved_shift.role,
                        ),
                    )
                    for solved_break in solved_shift.breaks:
                        cursor.execute(
                            '''
                            INSERT INTO "Break" ("id", "shiftId", "type", "startTime", "endTime", "paid", "createdAt")
                            VALUES (%s, %s, %s, %s, %s, %s, now())
                            ON CONFLICT ("id") DO UPDATE SET
                                "shiftId" = EXCLUDED."shiftId",
                                "type" = EXCLUDED."type",
                                "startTime" = EXCLUDED."startTime",
                                "endTime" = EXCLUDED."endTime",
                                "paid" = EXCLUDED."paid"
                            ''',
                            (
                                solved_break.id,
                                solved_shift.id,
                                solved_break.break_type,
                                solved_break.start_time,
                                solved_break.end_time,
                                solved_break.paid,
                            ),
                        )
                cursor.execute(
                    '''
                    UPDATE "ScheduleSolveJob"
                    SET
                        "status" = 'SUCCEEDED',
                        "statusReason" = NULL,
                        "retryCount" = %s,
                        "resultShiftCount" = %s,
                        "completedAt" = CURRENT_TIMESTAMP,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                      AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                    ''',
                    (
                        retry_count,
                        len(solved_shifts),
                        job_id,
                        solve_payload.tenant_id,
                        solve_payload.schedule_id,
                    ),
                )
    except NonRetryableJobError:
        raise
    except Exception as exc:
        raise RetryableJobError("failed to persist solved schedule") from exc


async def handle_email_job(payload: dict[str, Any]) -> dict[str, Any]:
    outbox_id = payload.get("outbox_id")
    if not isinstance(outbox_id, str) or not outbox_id.strip():
        raise NonRetryableJobError("email.send requires an opaque outbox_id")
    try:
        return await dispatch_password_reset_email(outbox_id.strip())
    except NonRetryableEmailError as exc:
        raise NonRetryableJobError(str(exc)) from exc
    except RetryableEmailError as exc:
        raise RetryableJobError(str(exc)) from exc


async def handle_pdf_job(payload: dict[str, Any]) -> dict[str, Any]:
    job_action = payload.get("action", "generate")
    if job_action == "parse":
        safe_path = resolve_worker_file_path(payload.get("file_path"))
        logger.info("Parsing PDF availability document")
        from src.parser.pdf_parser import AvailabilityParseError, AvailabilityParser

        parser = AvailabilityParser()
        try:
            result = parser.parse_document(safe_path)
        except AvailabilityParseError as exc:
            raise NonRetryableJobError(str(exc)) from exc
        return {"parsed": True, "data": result}

    logger.info("Generating PDF schedule report")
    return {"generated": True}


async def handle_billing_sync(payload: dict[str, Any]) -> dict[str, Any]:
    logger.info("Processing billing sync job tenant_ref=%s", safe_ref(str(payload.get("tenant_id", ""))))
    try:
        return await dispatch_usage(payload)
    except NonRetryableBillingError as exc:
        raise NonRetryableJobError(str(exc)) from exc
    except RetryableBillingError as exc:
        raise RetryableJobError(str(exc)) from exc


async def handle_webhook_delivery(payload: dict[str, Any]) -> dict[str, Any]:
    logger.info("Processing webhook delivery job")
    return {"delivered": True}


JOB_HANDLERS: dict[str, Callable[..., Awaitable[dict[str, Any]]]] = {
    "schedule.solve": handle_solve_job,
    "email.send": handle_email_job,
    "pdf.generate": handle_pdf_job,
    "billing.sync": handle_billing_sync,
    "webhook.deliver": handle_webhook_delivery,
}


async def process_message(body: bytes, message_id: str | None = None) -> dict[str, Any] | None:
    with TRACER.start_as_current_span("worker.process_job"):
        return await _process_message(body, message_id)


async def _process_message(body: bytes, message_id: str | None = None) -> dict[str, Any] | None:
    """Route one queue message to a handler after validation and duplicate checks."""
    message = parse_job_message(body)
    job_type = message.type if message.type in JOB_HANDLERS else "unknown"
    solve_payload: SolvePayload | None = None
    start = time.perf_counter()
    IN_FLIGHT_JOBS.inc()
    try:
        handler = JOB_HANDLERS.get(message.type)
        if not handler:
            raise NonRetryableJobError(f"Unknown job type: {message.type}")

        if message.type == "schedule.solve":
            solve_payload = validate_solve_payload(message.payload)
            claimed = await claim_schedule_solve_job(solve_payload, message.job_id, message.retry_count)
            if not claimed:
                logger.info("Skipping terminal schedule solve job job_ref=%s", safe_ref(message.job_id or ""))
                JOB_TOTAL.labels(type=job_type, status="duplicate").inc()
                return {"skipped": True, "status": "terminal"}

        idempotency_key = job_key(message, message_id)
        if idempotency_key in _COMPLETED_JOB_KEYS:
            logger.info("Skipping duplicate completed job job_ref=%s", safe_ref(idempotency_key))
            JOB_TOTAL.labels(type=job_type, status="duplicate").inc()
            return {"skipped": True}

        result = await handler(
            message.payload,
            message.job_id,
            message.retry_count,
        ) if solve_payload else await handler(message.payload)
        remember_completed_job(idempotency_key)
        JOB_TOTAL.labels(type=job_type, status="success").inc()
        logger.info("Job completed type=%s", job_type)
        return result
    except NonRetryableJobError as exc:
        if solve_payload:
            await try_mark_schedule_solve_job_status(
                solve_payload,
                message.job_id,
                "FAILED",
                job_status_reason(exc),
                message.retry_count,
            )
        JOB_TOTAL.labels(type=job_type, status="non_retryable").inc()
        raise
    except Exception as exc:
        JOB_TOTAL.labels(type=job_type, status="failed").inc()
        raise
    finally:
        JOB_DURATION.labels(type=job_type).observe(time.perf_counter() - start)
        IN_FLIGHT_JOBS.dec()


def parse_job_message(body: bytes) -> JobMessage:
    if len(body) > MAX_MESSAGE_BYTES:
        raise NonRetryableJobError("job message exceeds maximum size")
    try:
        raw = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise NonRetryableJobError("job message is not valid JSON") from exc
    try:
        return JobMessage.model_validate(raw)
    except ValidationError as exc:
        raise NonRetryableJobError("job message failed validation") from exc


def validate_solve_payload(payload: dict[str, Any]) -> SolvePayload:
    try:
        return SolvePayload.model_validate(payload)
    except ValidationError as exc:
        raise NonRetryableJobError("schedule solve payload failed validation") from exc


async def claim_schedule_solve_job(solve_payload: SolvePayload, job_id: str | None, retry_count: int) -> bool:
    if not os.getenv("DATABASE_URL"):
        return True
    if not job_id:
        raise NonRetryableJobError("schedule solve job id is required")
    return await asyncio.to_thread(_claim_schedule_solve_job_sync, solve_payload, job_id, retry_count)


def _claim_schedule_solve_job_sync(solve_payload: SolvePayload, job_id: str, retry_count: int) -> bool:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return True

    try:
        import psycopg
    except ImportError as exc:
        raise RetryableJobError("psycopg is required to update schedule job state") from exc

    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (solve_payload.tenant_id,))
                lock_scheduling_tenant(cursor, solve_payload.tenant_id)
                cursor.execute(
                    '''
                    SELECT "status"
                    FROM "ScheduleSolveJob"
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                    FOR UPDATE
                    ''',
                    (job_id, solve_payload.tenant_id, solve_payload.schedule_id),
                )
                row = cursor.fetchone()
                if not row:
                    raise NonRetryableJobError("schedule solve job not found")
                if str(row[0]) in SCHEDULE_JOB_TERMINAL_STATUSES:
                    return False
                cursor.execute(
                    '''
                    UPDATE "ScheduleSolveJob"
                    SET
                        "status" = 'RUNNING',
                        "statusReason" = NULL,
                        "retryCount" = %s,
                        "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
                        "completedAt" = NULL,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                    ''',
                    (retry_count, job_id, solve_payload.tenant_id, solve_payload.schedule_id),
                )
                return True
    except (RetryableJobError, NonRetryableJobError):
        raise
    except Exception as exc:
        raise RetryableJobError("failed to claim schedule solve job") from exc


async def try_mark_schedule_solve_job_status(
    solve_payload: SolvePayload,
    job_id: str | None,
    status: str,
    reason: str,
    retry_count: int,
) -> None:
    if not job_id or not os.getenv("DATABASE_URL"):
        return
    await asyncio.to_thread(
        _update_schedule_solve_job_status_sync,
        solve_payload,
        job_id,
        status,
        reason,
        retry_count,
        None,
    )


def _update_schedule_solve_job_status_sync(
    solve_payload: SolvePayload,
    job_id: str,
    status: str,
    reason: str | None,
    retry_count: int,
    result_shift_count: int | None,
) -> None:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return
    if status not in {"RETRYING", "SUCCEEDED", "FAILED", "DEAD_LETTERED"}:
        raise ValueError("unsupported schedule solve job status")

    try:
        import psycopg
    except ImportError as exc:
        raise RetryableJobError("psycopg is required to update schedule job state") from exc

    terminal = status in SCHEDULE_JOB_TERMINAL_STATUSES
    safe_reason = truncate_status_reason(reason)
    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (solve_payload.tenant_id,))
                lock_tenant_status(cursor, solve_payload.tenant_id)
                cursor.execute(
                    '''
                    WITH updated_job AS (
                    UPDATE "ScheduleSolveJob"
                    SET
                        "status" = %s,
                        "statusReason" = %s,
                        "retryCount" = %s,
                        "resultShiftCount" = %s,
                        "completedAt" = CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE NULL END,
                        "publicationStatus" = CASE WHEN %s THEN 'PUBLISHED' ELSE "publicationStatus" END,
                        "publishedAt" = CASE WHEN %s THEN CURRENT_TIMESTAMP ELSE "publishedAt" END,
                        "publishLeaseUntil" = CASE WHEN %s THEN NULL ELSE "publishLeaseUntil" END,
                        "publishLastError" = CASE WHEN %s THEN NULL ELSE "publishLastError" END,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                      AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                    RETURNING "tenantId", "creditConsumption"
                    ), inserted_refund AS (
                    INSERT INTO "CreditTransaction" ("id", "tenantId", "amount", "reason", "createdAt")
                    SELECT
                        %s,
                        "tenantId",
                        ("creditConsumption"->>'consumedCredits')::integer,
                        %s,
                        CURRENT_TIMESTAMP
                    FROM updated_job
                    WHERE %s
                      AND "creditConsumption"->>'source' = 'credits'
                      AND jsonb_typeof("creditConsumption"->'consumedCredits') = 'number'
                      AND ("creditConsumption"->>'consumedCredits')::integer > 0
                    ON CONFLICT ("id") DO NOTHING
                    RETURNING "tenantId", "amount"
                    )
                    UPDATE "Tenant" tenant
                    SET
                        "usageCredits" = tenant."usageCredits" + inserted_refund."amount",
                        "updatedAt" = CURRENT_TIMESTAMP
                    FROM inserted_refund
                    WHERE tenant."id" = inserted_refund."tenantId"
                    ''',
                    (
                        status,
                        safe_reason,
                        retry_count,
                        result_shift_count,
                        terminal,
                        status == "RETRYING",
                        status == "RETRYING",
                        status == "RETRYING",
                        status == "RETRYING",
                        job_id,
                        solve_payload.tenant_id,
                        solve_payload.schedule_id,
                        f"schedule-credit-refund-{job_id}",
                        f"Schedule generation refund ({job_id})",
                        status in {"FAILED", "DEAD_LETTERED"},
                    ),
                )
    except RetryableJobError:
        raise
    except Exception as exc:
        raise RetryableJobError("failed to update schedule solve job status") from exc


def job_status_reason(exc: Exception) -> str:
    message = str(exc).strip() or exc.__class__.__name__
    return truncate_status_reason(message) or exc.__class__.__name__


def truncate_status_reason(reason: str | None) -> str | None:
    if not reason:
        return None
    return reason[:512]


def normalize_solved_shifts(solve_payload: SolvePayload, response: Any) -> list[NormalizedShift]:
    try:
        schedule_start = parse_iso_datetime(solve_payload.start_date, "start_date")
        schedule_end = parse_iso_datetime(solve_payload.end_date, "end_date")
    except ValueError as exc:
        raise NonRetryableJobError(str(exc)) from exc

    solved_shifts: list[NormalizedShift] = []
    staff_ids = set(solve_payload.staff_ids)
    seen_shift_keys: set[tuple[str, str, str, str]] = set()

    for index, raw_shift in enumerate(getattr(response, "shifts", [])):
        staff_id = str(getattr(raw_shift, "staff_id", "")).strip()
        if staff_id not in staff_ids:
            raise NonRetryableJobError("solve response includes staff outside the tenant")
        try:
            start_time = parse_iso_datetime(getattr(raw_shift, "start_time", ""), f"shifts[{index}].start_time", require_time=True)
            end_time = parse_iso_datetime(getattr(raw_shift, "end_time", ""), f"shifts[{index}].end_time", require_time=True)
            role = normalize_shift_role(getattr(raw_shift, "role", "STAFF"))
        except ValueError as exc:
            raise NonRetryableJobError(str(exc)) from exc

        if end_time <= start_time:
            raise NonRetryableJobError("solve response includes a shift with end_time before start_time")
        if start_time < schedule_start or end_time > schedule_end:
            raise NonRetryableJobError("solve response includes a shift outside the schedule window")

        shift_key = (staff_id, instant_key(start_time), instant_key(end_time), role)
        if shift_key in seen_shift_keys:
            raise NonRetryableJobError("solve response includes duplicate shifts")
        seen_shift_keys.add(shift_key)

        shift_id = deterministic_id(
            "shift",
            solve_payload.tenant_id,
            solve_payload.schedule_id,
            solve_payload.location_id,
            staff_id,
            instant_key(start_time),
            instant_key(end_time),
            role,
        )
        breaks = normalize_solved_breaks(raw_shift, shift_id, start_time, end_time)
        solved_shift = NormalizedShift(
            id=shift_id,
            staff_id=staff_id,
            start_time=start_time,
            end_time=end_time,
            role=role,
            breaks=breaks,
        )
        solved_shifts.append(solved_shift)

    if not solved_shifts:
        raise NonRetryableJobError("engine returned no solved shifts")
    return coalesce_adjacent_solved_shifts(solve_payload, solved_shifts)


def coalesce_adjacent_solved_shifts(
    solve_payload: SolvePayload,
    solved_shifts: list[NormalizedShift],
) -> list[NormalizedShift]:
    coalesced: list[NormalizedShift] = []
    ordered = sorted(
        solved_shifts,
        key=lambda shift: (shift.staff_id, shift.start_time, shift.end_time, shift.role, shift.id),
    )
    for shift in ordered:
        previous = coalesced[-1] if coalesced and coalesced[-1].staff_id == shift.staff_id else None
        if previous and shift.start_time < previous.end_time:
            raise NonRetryableJobError("solve response includes overlapping shifts for one staff member")
        if previous and shift.start_time == previous.end_time and shift.role == previous.role:
            merged_id = deterministic_id(
                "shift",
                solve_payload.tenant_id,
                solve_payload.schedule_id,
                solve_payload.location_id,
                shift.staff_id,
                instant_key(previous.start_time),
                instant_key(shift.end_time),
                shift.role,
            )
            merged_breaks = sorted(previous.breaks + shift.breaks, key=lambda item: (item.start_time, item.end_time, item.id))
            coalesced[-1] = NormalizedShift(
                id=merged_id,
                staff_id=shift.staff_id,
                start_time=previous.start_time,
                end_time=shift.end_time,
                role=shift.role,
                breaks=[
                    NormalizedBreak(
                        id=deterministic_id(
                            "break",
                            merged_id,
                            str(index),
                            instant_key(item.start_time),
                            instant_key(item.end_time),
                            item.break_type,
                        ),
                        start_time=item.start_time,
                        end_time=item.end_time,
                        paid=item.paid,
                        break_type=item.break_type,
                    )
                    for index, item in enumerate(merged_breaks)
                ],
            )
            continue
        coalesced.append(shift)
    return coalesced


def normalize_solved_breaks(raw_shift: Any, shift_id: str, shift_start: datetime, shift_end: datetime) -> list[NormalizedBreak]:
    normalized: list[NormalizedBreak] = []
    seen_breaks: set[tuple[str, str, str]] = set()
    for index, raw_break in enumerate(getattr(raw_shift, "breaks", [])):
        try:
            start_time = parse_iso_datetime(getattr(raw_break, "start_time", ""), f"breaks[{index}].start_time", require_time=True)
            end_time = parse_iso_datetime(getattr(raw_break, "end_time", ""), f"breaks[{index}].end_time", require_time=True)
            break_type = normalize_break_type(getattr(raw_break, "type", "LUNCH"))
        except ValueError as exc:
            raise NonRetryableJobError(str(exc)) from exc

        if not (shift_start <= start_time < end_time <= shift_end):
            raise NonRetryableJobError("solve response includes a break outside its shift window")

        break_key = (instant_key(start_time), instant_key(end_time), break_type)
        if break_key in seen_breaks:
            raise NonRetryableJobError("solve response includes duplicate breaks")
        seen_breaks.add(break_key)

        normalized.append(NormalizedBreak(
            id=deterministic_id("break", shift_id, str(index), *break_key),
            start_time=start_time,
            end_time=end_time,
            paid=bool(getattr(raw_break, "paid", False)),
            break_type=break_type,
        ))
    normalized.sort(key=lambda item: (item.start_time, item.end_time, item.id))
    for previous, current in zip(normalized, normalized[1:]):
        if previous.end_time > current.start_time:
            raise NonRetryableJobError("solve response includes overlapping breaks")
    return normalized


def validate_solved_demand_coverage(
    solve_payload: SolvePayload,
    solved_shifts: list[NormalizedShift],
) -> None:
    if not solve_payload.demand_windows:
        validate_solved_daily_coverage(solve_payload, solved_shifts)
        return

    for window in solve_payload.demand_windows:
        window_start = parse_iso_datetime(window.start_time, "demand window start_time", require_time=True)
        window_end = parse_iso_datetime(window.end_time, "demand window end_time", require_time=True)
        boundaries = {window_start, window_end}
        for shift in solved_shifts:
            if shift.end_time <= window_start or shift.start_time >= window_end:
                continue
            boundaries.add(max(window_start, shift.start_time))
            boundaries.add(min(window_end, shift.end_time))
            for shift_break in shift.breaks:
                if shift_break.end_time <= window_start or shift_break.start_time >= window_end:
                    continue
                boundaries.add(max(window_start, shift_break.start_time))
                boundaries.add(min(window_end, shift_break.end_time))

        ordered = sorted(boundaries)
        for index in range(len(ordered) - 1):
            segment_start = ordered[index]
            segment_end = ordered[index + 1]
            working = [
                shift
                for shift in solved_shifts
                if shift.start_time <= segment_start
                and shift.end_time >= segment_end
                and not any(
                    shift_break.start_time < segment_end and shift_break.end_time > segment_start
                    for shift_break in shift.breaks
                )
            ]
            if len(working) < window.required_staff:
                raise NonRetryableJobError(
                    f"solve response drops working coverage below demand window {window.id} during a break"
                )
            if window.skill:
                required_skill = window.skill.strip().lower()
                qualified = sum(
                    1
                    for shift in working
                    if required_skill in {
                        skill.strip().lower()
                        for skill in solve_payload.staff_skills.get(shift.staff_id, [])
                    }
                )
                if qualified < window.required_staff:
                    raise NonRetryableJobError(
                        f"solve response drops working skill coverage below demand window {window.id} during a break"
                    )


def validate_solved_daily_coverage(
    solve_payload: SolvePayload,
    solved_shifts: list[NormalizedShift],
) -> None:
    time_zone = ZoneInfo(solve_payload.timezone)
    shifts_by_date: dict[str, list[NormalizedShift]] = {}
    for shift in solved_shifts:
        local_date = shift.start_time.astimezone(time_zone).date().isoformat()
        shifts_by_date.setdefault(local_date, []).append(shift)

    for local_date, shifts in shifts_by_date.items():
        required_staff = daily_required_staff(solve_payload, local_date, time_zone)
        boundaries = {shift.start_time for shift in shifts} | {shift.end_time for shift in shifts}
        for shift in shifts:
            for shift_break in shift.breaks:
                boundaries.add(shift_break.start_time)
                boundaries.add(shift_break.end_time)
        ordered = sorted(boundaries)
        for index in range(len(ordered) - 1):
            segment_start = ordered[index]
            segment_end = ordered[index + 1]
            working = sum(
                1
                for shift in shifts
                if shift.start_time <= segment_start
                and shift.end_time >= segment_end
                and not any(
                    shift_break.start_time < segment_end and shift_break.end_time > segment_start
                    for shift_break in shift.breaks
                )
            )
            if working < required_staff:
                raise NonRetryableJobError(
                    f"solve response drops working coverage below daily demand for {local_date} during a break"
                )


def daily_required_staff(solve_payload: SolvePayload, local_date: str, time_zone: ZoneInfo) -> int:
    default = int(solve_payload.constraints.get("min_floor_coverage", 1))
    demand = solve_payload.daily_demand
    if isinstance(demand, int) and not isinstance(demand, bool):
        return max(default, demand)
    if not isinstance(demand, dict):
        return default

    local_day = datetime.fromisoformat(f"{local_date}T12:00:00").replace(tzinfo=time_zone)
    weekday = local_day.strftime("%A")
    values = [default]
    for key in ("*", local_date, weekday, weekday.lower()):
        value = demand.get(key)
        if isinstance(value, int) and not isinstance(value, bool):
            values.append(value)
    return max(values)


def parse_iso_datetime(value: Any, field: str, require_time: bool = False) -> datetime:
    if not isinstance(value, str) or not value.strip():
        raise ValueError(f"{field} must be an ISO date or datetime string")
    raw = value.strip()
    if require_time and "T" not in raw and " " not in raw:
        raise ValueError(f"{field} must include a time component")
    normalized = raw[:-1] + "+00:00" if raw.endswith("Z") else raw
    try:
        parsed = datetime.fromisoformat(normalized)
    except ValueError as exc:
        raise ValueError(f"{field} must be a valid ISO date or datetime string") from exc
    if parsed.tzinfo is None:
        parsed = parsed.replace(tzinfo=timezone.utc)
    return parsed.astimezone(timezone.utc)


def normalize_shift_role(value: Any) -> str:
    if value is None:
        return "STAFF"
    if not isinstance(value, str):
        raise ValueError("shift role must be a string")
    role = value.strip() or "STAFF"
    if len(role) > SHIFT_ROLE_MAX_LENGTH:
        raise ValueError("shift role is too long")
    return role


def normalize_break_type(value: Any) -> str:
    if value is None:
        return "LUNCH"
    if not isinstance(value, str):
        raise ValueError("break type must be a string")
    key = value.strip().upper()
    if key not in BREAK_TYPE_ALIASES:
        raise ValueError("break type is not supported")
    return BREAK_TYPE_ALIASES[key]


def deterministic_id(*parts: str) -> str:
    payload = "lunchlineup:solved-schedule:" + "|".join(parts)
    return str(uuid.uuid5(uuid.NAMESPACE_URL, payload))


def instant_key(value: datetime) -> str:
    return value.astimezone(timezone.utc).isoformat(timespec="microseconds")


def revision_key(value: Any) -> str:
    if isinstance(value, datetime):
        parsed = value.replace(tzinfo=timezone.utc) if value.tzinfo is None else value
        return instant_key(parsed)
    return instant_key(parse_iso_datetime(str(value), "revision", require_time=True))


def load_solver_modules():
    import solver_pb2
    import solver_pb2_grpc

    return solver_pb2, solver_pb2_grpc


def job_key(message: JobMessage, message_id: str | None) -> str:
    raw_key = "|".join([
        message.type,
        message.job_id or message_id or "",
        str(message.payload.get("tenant_id", "")),
        str(message.payload.get("schedule_id", "")),
        str(message.payload.get("location_id", "")),
    ])
    return hashlib.sha256(raw_key.encode("utf-8")).hexdigest()


def remember_completed_job(key: str) -> None:
    _COMPLETED_JOB_KEYS[key] = time.time()
    _COMPLETED_JOB_KEYS.move_to_end(key)
    while len(_COMPLETED_JOB_KEYS) > _MAX_COMPLETED_KEYS:
        _COMPLETED_JOB_KEYS.popitem(last=False)


def safe_ref(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def resolve_worker_file_path(file_path: Any) -> str:
    if not isinstance(file_path, str) or not file_path.strip():
        raise NonRetryableJobError("file_path is required")
    root = Path(os.getenv("WORKER_UPLOAD_ROOT", "/app/uploads")).resolve()
    candidate = Path(file_path)
    if not candidate.is_absolute():
        candidate = root / candidate
    resolved = candidate.resolve()
    if resolved != root and root not in resolved.parents:
        raise NonRetryableJobError("file_path must stay inside WORKER_UPLOAD_ROOT")
    return str(resolved)


async def consume_queue(queue: Any, channel: Any) -> None:
    async with queue.iterator() as queue_iter:
        async for message in queue_iter:
            update_solver_queue_depth(queue)
            await handle_queue_message(channel, message)


async def run_worker_tasks(queue: Any, channel: Any) -> None:
    consumer_task = asyncio.create_task(
        consume_queue(queue, channel),
        name="rabbitmq-consumer",
    )
    tasks = {consumer_task: "rabbitmq-consumer"}
    if metered_usage_enabled():
        billing_task = asyncio.create_task(
            run_billing_usage_loop(),
            name="billing-usage-sweep",
        )
        tasks[billing_task] = "billing-usage-sweep"
    if password_reset_email_enabled():
        password_reset_task = asyncio.create_task(
            run_password_reset_email_loop(),
            name="password-reset-email-sweep",
        )
        tasks[password_reset_task] = "password-reset-email-sweep"

    try:
        done, _ = await asyncio.wait(tasks, return_when=asyncio.FIRST_COMPLETED)
        stopped_background = next(
            (task for task in done if task is not consumer_task),
            None,
        )
        if stopped_background is not None:
            task_name = tasks[stopped_background]
            if stopped_background.cancelled():
                raise RuntimeError(f"Required background task stopped unexpectedly: {task_name}")
            error = stopped_background.exception()
            if error is not None:
                raise RuntimeError(f"Required background task failed: {task_name}") from error
            raise RuntimeError(f"Required background task exited unexpectedly: {task_name}")
        await consumer_task
    finally:
        for task in tasks:
            if not task.done():
                task.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)


async def start_consumer():
    """Connect to RabbitMQ and consume durable messages."""
    try:
        import aio_pika

        connection = await aio_pika.connect_robust(RABBITMQ_URL)
        channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
        await channel.set_qos(prefetch_count=int_env("WORKER_PREFETCH", 10, 1, 100))

        await channel.declare_queue(DLQ_NAME, durable=True)
        queue = await channel.declare_queue(
            QUEUE_NAME,
            durable=True,
            arguments={
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": DLQ_NAME,
            },
        )
        await declare_retry_queues(channel)
        update_solver_queue_depth(queue)

        logger.info("Worker connected to RabbitMQ queue=%s", QUEUE_NAME)
        try:
            await run_worker_tasks(queue, channel)
        finally:
            await connection.close()

    except ImportError:
        logger.warning("aio-pika not installed; running in standalone mode")
    except Exception as e:
        logger.error("Failed to connect to RabbitMQ: %s", e)
        raise


async def handle_queue_message(channel: Any, message: Any) -> None:
    """Settle one source message only after durable replacement ownership is known."""
    try:
        await process_message(message.body, message_id=message.message_id)
    except NonRetryableJobError as exc:
        logger.warning("Non-retryable job routed to DLQ reason=%s", exc.__class__.__name__)
        await message.reject(requeue=False)
        return
    except Exception as exc:
        retry_count = read_retry_count(message.body)
        job_type = read_job_type(message.body)
        if retry_count >= MAX_RETRIES:
            try:
                await try_mark_schedule_status_from_message(
                    message.body,
                    "DEAD_LETTERED",
                    exc,
                    MAX_RETRIES,
                )
            except Exception as state_error:
                logger.error(
                    "Terminal schedule state update failed; source will be requeued type=%s reason=%s",
                    job_type,
                    state_error.__class__.__name__,
                )
                await asyncio.sleep(RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
                await message.nack(requeue=True)
                return
            logger.error("Job exhausted retries and will route to DLQ type=%s", job_type)
            await message.reject(requeue=False)
            return

        replacement_retry_count = retry_count + 1
        try:
            await publish_retry(
                channel.default_exchange,
                message.body,
                replacement_retry_count,
                message.message_id,
            )
        except Exception as publish_error:
            logger.warning(
                "Retry replacement publish failed; source will be requeued type=%s reason=%s",
                job_type,
                publish_error.__class__.__name__,
            )
            await asyncio.sleep(RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
            await message.nack(requeue=True)
            return

        try:
            await try_mark_schedule_status_from_message(
                message.body,
                "RETRYING",
                exc,
                replacement_retry_count,
            )
        except Exception as state_error:
            logger.error(
                "Confirmed retry state update failed; replacement still owns delivery type=%s reason=%s",
                job_type,
                state_error.__class__.__name__,
            )
        JOB_RETRIES.labels(type=job_type).inc()
        logger.warning(
            "Job retry queued type=%s retry=%s reason=%s",
            job_type,
            replacement_retry_count,
            exc.__class__.__name__,
        )
        await message.ack()
        return

    await message.ack()


async def try_mark_schedule_status_from_message(
    body: bytes,
    status: str,
    reason: Exception,
    retry_count: int,
) -> None:
    message = parse_job_message(body)
    if message.type != "schedule.solve":
        return
    solve_payload = validate_solve_payload(message.payload)
    await try_mark_schedule_solve_job_status(
        solve_payload,
        message.job_id,
        status,
        job_status_reason(reason),
        retry_count,
    )


def read_retry_count(body: bytes) -> int:
    try:
        raw = json.loads(body.decode("utf-8"))
        return int(raw.get("retry_count", 0))
    except Exception:
        return 0


def read_job_type(body: bytes) -> str:
    try:
        raw = json.loads(body.decode("utf-8"))
        job_type = raw.get("type", "unknown")
        return job_type if job_type in JOB_HANDLERS else "unknown"
    except Exception:
        return "unknown"


def retry_delay_ms(retry_count: int) -> int:
    index = max(0, min(retry_count - 1, len(RETRY_BACKOFF_SECONDS) - 1))
    return RETRY_BACKOFF_SECONDS[index] * 1000


def retry_queue_name(retry_count: int) -> str:
    index = max(1, min(retry_count, len(RETRY_BACKOFF_SECONDS)))
    return f"{RETRY_QUEUE_PREFIX}.{index}"


async def declare_retry_queues(channel: Any) -> None:
    for retry_count in range(1, min(MAX_RETRIES, len(RETRY_BACKOFF_SECONDS)) + 1):
        await channel.declare_queue(
            retry_queue_name(retry_count),
            durable=True,
            arguments={
                "x-message-ttl": retry_delay_ms(retry_count),
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": QUEUE_NAME,
            },
        )


def update_solver_queue_depth(queue: Any) -> None:
    message_count = getattr(getattr(queue, "declaration_result", None), "message_count", None)
    if isinstance(message_count, int):
        SOLVER_QUEUE_DEPTH.set(message_count)


async def publish_retry(exchange: Any, body: bytes, retry_count: int, message_id: str | None) -> None:
    import aio_pika

    raw = json.loads(body.decode("utf-8"))
    raw["retry_count"] = retry_count
    encoded = json.dumps(raw, separators=(",", ":")).encode("utf-8")
    await exchange.publish(
        aio_pika.Message(
            encoded,
            content_type="application/json",
            delivery_mode=aio_pika.DeliveryMode.PERSISTENT,
            message_id=message_id,
            headers={"x-retry-count": retry_count},
        ),
        routing_key=retry_queue_name(retry_count),
    )


def start_metrics_server() -> None:
    global _METRICS_STARTED
    if _METRICS_STARTED:
        return
    port = int_env("WORKER_METRICS_PORT", 3003, 1, 65535)
    start_http_server(port)
    _METRICS_STARTED = True
    logger.info("Worker metrics endpoint started port=%s", port)


def validate_runtime_config() -> None:
    if ENVIRONMENT == "production":
        for key in ("RABBITMQ_URL", "ENGINE_GRPC_URL", "DATABASE_URL"):
            if not os.getenv(key):
                raise RuntimeError(f"{key} is required in production")
        if "guest:guest" in RABBITMQ_URL:
            raise RuntimeError("RABBITMQ_URL must not use guest credentials in production")
    if not ENGINE_GRPC_URL:
        raise RuntimeError("ENGINE_GRPC_URL is required")
    validate_billing_runtime_config()
    validate_password_reset_email_config()


if __name__ == "__main__":
    logger.info("Starting LunchLineup Worker")
    validate_runtime_config()
    start_metrics_server()
    asyncio.run(start_consumer())
