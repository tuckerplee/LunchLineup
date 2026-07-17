"""
RabbitMQ background worker.

Consumes durable job messages, validates payloads at the queue boundary, and
delegates schedule solves to the engine with bounded retries and deadlines.
"""

from __future__ import annotations

import asyncio
from collections import OrderedDict
from dataclasses import dataclass, field
from datetime import date, datetime, timezone
import hashlib
import json
import logging
import os
from pathlib import Path
import re
import signal
import socket
import threading
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
from src.staff_invitation_outbox import (
    run_staff_invitation_outbox_loop,
    staff_invitation_outbox_enabled,
    validate_staff_invitation_outbox_config,
)
from src.availability_import import (
    AvailabilityImportBusy,
    AvailabilityImportRejected,
    mark_import_retry,
    process_availability_import,
    run_availability_import_retention_loop,
    validate_availability_import_config,
)
from src.parser_health import PDF_PARSER_READY, run_pdf_parser_health_loop

configure_tracing("lunchlineup-worker")
TRACER = trace.get_tracer("lunchlineup.worker")

logger = logging.getLogger("worker")
logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(name)s %(message)s")

ID_PATTERN = r"^[A-Za-z0-9._:@+-]{1,128}$"
ID_RE = re.compile(ID_PATTERN)
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
SCHEDULE_SOLVE_EXECUTION_LEASE_SECONDS = int_env(
    "WORKER_SCHEDULE_SOLVE_EXECUTION_LEASE_SECONDS", 300, 60, 1800
)
SOLVER_QUEUE_DEPTH_POLL_SECONDS = int_env(
    "WORKER_QUEUE_DEPTH_POLL_SECONDS", 15, 5, 300
)
WORKER_SHUTDOWN_TIMEOUT_SECONDS = float_env(
    "WORKER_SHUTDOWN_TIMEOUT_SECONDS", 30.0, 1.0, 120.0
)
GRPC_CLOSE_TIMEOUT_SECONDS = float_env(
    "WORKER_GRPC_CLOSE_TIMEOUT_SECONDS", 2.0, 0.1, 10.0
)
SOLVE_SUCCESS_STATUS = "SUCCESS"
SCHEDULE_JOB_TERMINAL_STATUSES = {"SUCCEEDED", "FAILED", "DEAD_LETTERED"}
POSTGRES_INTEGER_MAX = 2_147_483_647
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
_METRICS_SERVER: Any | None = None
_METRICS_THREAD: threading.Thread | None = None
_ACTIVE_RABBIT_CONNECTION: Any | None = None
_ACTIVE_RABBIT_CHANNEL: Any | None = None
_ACTIVE_GRPC_CHANNELS: set[Any] = set()
_COMPLETED_JOB_KEYS: OrderedDict[str, float] = OrderedDict()
_MAX_COMPLETED_KEYS = int_env("WORKER_IDEMPOTENCY_CACHE_SIZE", 10_000, 100, 100_000)

WORKER_READY = Gauge(
    "lunchlineup_worker_ready",
    "Whether the worker is accepting RabbitMQ deliveries",
)
JOB_TOTAL = Counter("lunchlineup_worker_jobs_total", "Jobs processed by the worker", ["type", "status"])
JOB_RETRIES = Counter("lunchlineup_worker_job_retries_total", "Jobs republished for retry", ["type"])
JOB_DURATION = Histogram(
    "lunchlineup_worker_job_duration_seconds",
    "Time spent processing worker jobs",
    ["type"],
    buckets=[0.05, 0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0, 60.0],
)
IN_FLIGHT_JOBS = Gauge("lunchlineup_worker_in_flight_jobs", "Jobs currently being processed by this worker")
SOLVER_QUEUE_DEPTH = Gauge(
    "lunchlineup_solver_queue_depth",
    "Ready and delayed-retry jobs pending in the schedule solver queues",
)
SOLVER_QUEUE_MESSAGES = Gauge(
    "lunchlineup_solver_queue_messages",
    "RabbitMQ schedule solver messages by queue state",
    ["state"],
)
SOLVER_QUEUE_TELEMETRY_AVAILABLE = Gauge(
    "lunchlineup_solver_queue_telemetry_available",
    "Whether the latest complete RabbitMQ solver queue snapshot succeeded",
)
SOLVER_TERMINAL_TRANSITIONS = Counter(
    "lunchlineup_solver_terminal_transitions_total",
    "Messages durably routed to the schedule solver dead-letter queue",
    ["reason"],
)

MAX_EXCEPTION_CHAIN_DEPTH = 8
SANITIZED_FAILURE_CLASSES = frozenset({
    "database_configuration",
    "database_connectivity",
    "database_operation",
    "message_broker_connectivity",
    "scheduling_engine_rpc",
    "dependency_timeout",
    "dependency_connectivity",
    "runtime_dependency_missing",
    "invalid_runtime_input",
    "retryable_job",
    "non_retryable_job",
    "job_busy",
    "job_ownership_lost",
    "internal_error",
})
JOB_STATUS_REASON_BY_FAILURE_CLASS = {
    failure_class: f"WORKER_FAILURE_{failure_class.upper()}"
    for failure_class in SANITIZED_FAILURE_CLASSES
}
INTERNAL_JOB_STATUS_REASON = JOB_STATUS_REASON_BY_FAILURE_CLASS["internal_error"]


def sanitized_failure_class(error: BaseException) -> str:
    """Return a bounded operational classification without emitting exception text."""

    chain: list[BaseException] = []
    seen: set[int] = set()
    current: BaseException | None = error
    while current is not None and len(chain) < MAX_EXCEPTION_CHAIN_DEPTH and id(current) not in seen:
        chain.append(current)
        seen.add(id(current))
        current = current.__cause__ or current.__context__

    names = {item.__class__.__name__ for item in chain}
    modules = {item.__class__.__module__.split(".", 1)[0].lower() for item in chain}
    messages: list[str] = []
    for item in chain:
        try:
            messages.append(str(item).lower())
        except Exception:
            continue
    combined_message = " ".join(messages)

    database_configuration_markers = (
        "invalid connection option",
        "invalid dsn",
        "invalid uri query parameter",
        "missing \"=\" after",
        "extra key/value separator",
    )
    if any(marker in combined_message for marker in database_configuration_markers):
        return "database_configuration"
    if "psycopg" in modules:
        if names & {"ProgrammingError", "InterfaceError"}:
            return "database_configuration"
        if "OperationalError" in names:
            return "database_connectivity"
        return "database_operation"
    if modules & {"aio_pika", "aiormq", "pamqp"}:
        return "message_broker_connectivity"
    if "grpc" in modules:
        return "scheduling_engine_rpc"
    if names & {"TimeoutError", "CancelledError"}:
        return "dependency_timeout"
    if names & {"ConnectionError", "ConnectionRefusedError", "ConnectionResetError", "OSError"}:
        return "dependency_connectivity"
    if names & {"ImportError", "ModuleNotFoundError"}:
        return "runtime_dependency_missing"
    if names & {"ValidationError", "ValueError", "JSONDecodeError"}:
        return "invalid_runtime_input"
    if "ScheduleJobBusyError" in names:
        return "job_busy"
    if "ScheduleJobOwnershipLostError" in names:
        return "job_ownership_lost"
    if "RetryableJobError" in names:
        return "retryable_job"
    if "NonRetryableJobError" in names:
        return "non_retryable_job"
    return "internal_error"


class RetryableJobError(RuntimeError):
    pass


class NonRetryableJobError(RuntimeError):
    pass


class ScheduleCreditProvenanceError(NonRetryableJobError):
    pass


class ScheduleJobBusyError(RuntimeError):
    pass


class ScheduleJobOwnershipLostError(RuntimeError):
    pass


class WorkerDrainTimeout(RuntimeError):
    pass


@dataclass
class ShutdownCoordinator:
    timeout_seconds: float = WORKER_SHUTDOWN_TIMEOUT_SECONDS
    event: asyncio.Event = field(default_factory=asyncio.Event)
    reason: str | None = None
    signal_number: int | None = None
    deadline: float | None = None

    def request(self, reason: str, signal_number: int | None = None) -> None:
        if signal_number is not None and self.signal_number is None:
            self.signal_number = signal_number
        if self.event.is_set():
            return
        self.reason = reason
        self.deadline = time.monotonic() + self.timeout_seconds
        mark_worker_unready()
        self.event.set()
        logger.info("Worker shutdown requested reason=%s", reason)

    def remaining(self) -> float:
        if self.deadline is None:
            return self.timeout_seconds
        return max(0.0, self.deadline - time.monotonic())


def mark_worker_unready() -> None:
    WORKER_READY.set(0)
    PDF_PARSER_READY.set(0)
    SOLVER_QUEUE_TELEMETRY_AVAILABLE.set(0)


def lock_tenant_status(cursor: Any, tenant_id: str) -> str | None:
    cursor.execute(
        'SELECT "status" FROM "Tenant" WHERE "id" = %s FOR UPDATE',
        (tenant_id,),
    )
    tenant = cursor.fetchone()
    return str(tenant[0]) if tenant else None


def lock_scheduling_tenant_state(
    cursor: Any,
    tenant_id: str,
) -> tuple[str, str, str, bool] | None:
    cursor.execute(
        '''
        SELECT
            "status",
            "planTier",
            "stripeSubscriptionId",
            "stripeSubscriptionCurrentPeriodEnd" > CURRENT_TIMESTAMP
        FROM "Tenant"
        WHERE "id" = %s
        FOR UPDATE
        ''',
        (tenant_id,),
    )
    tenant = cursor.fetchone()
    if not tenant:
        return None
    return (
        str(tenant[0]),
        str(tenant[1]),
        str(tenant[2] or "").strip(),
        tenant[3] is True,
    )


def require_active_paid_scheduling_tenant(
    tenant: tuple[str, str, str, bool] | None,
) -> None:
    if (
        not tenant
        or tenant[0] != "ACTIVE"
        or tenant[1] == "FREE"
        or not tenant[2]
        or not tenant[3]
    ):
        raise NonRetryableJobError(
            "tenant does not have an active paid subscription for schedule solving"
        )


def lock_scheduling_tenant(cursor: Any, tenant_id: str) -> None:
    require_active_paid_scheduling_tenant(
        lock_scheduling_tenant_state(cursor, tenant_id)
    )


def lock_scheduling_mutations(cursor: Any, tenant_id: str) -> None:
    cursor.execute(
        "SELECT pg_advisory_xact_lock(hashtextextended(%s, 0))",
        (f"lunchlineup:scheduling:{tenant_id}",),
    )


@dataclass
class NormalizedBreak:
    id: str
    start_time: datetime
    end_time: datetime
    paid: bool
    break_type: str


@dataclass(frozen=True)
class ScheduleSolveJobIdentity:
    tenant_id: str
    schedule_id: str
    location_id: str


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
    draft_revision: int = Field(..., ge=0, le=POSTGRES_INTEGER_MAX)
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
    execution_token: str | None = None,
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
    await persist_solved_schedule(solve_payload, solved_shifts, job_id, retry_count, execution_token)
    logger.info("Solve complete schedule_ref=%s shifts=%s", schedule_ref, len(solved_shifts))
    return {"status": response.status, "schedule_id": response.schedule_id, "shift_count": len(solved_shifts)}


async def calculate_schedule(request: Any, solver_pb2_grpc: Any) -> Any:
    channel = grpc.aio.insecure_channel(ENGINE_GRPC_URL)
    _ACTIVE_GRPC_CHANNELS.add(channel)
    try:
        stub = solver_pb2_grpc.SolverServiceStub(channel)
        return await stub.CalculateSchedule(
            request,
            timeout=ENGINE_GRPC_TIMEOUT_SECONDS,
            metadata=current_trace_metadata(),
        )
    except grpc.aio.AioRpcError as exc:
        raise RetryableJobError(f"engine rpc failed: {exc.code().name}") from exc
    finally:
        await close_grpc_channel(channel)


async def close_grpc_channel(channel: Any) -> None:
    close_task = asyncio.create_task(channel.close(grace=0))
    done, pending = await asyncio.wait(
        {close_task},
        timeout=GRPC_CLOSE_TIMEOUT_SECONDS,
    )
    if pending:
        close_task.cancel()
        force_close_grpc_channel(channel)
    elif done:
        await close_task
    _ACTIVE_GRPC_CHANNELS.discard(channel)


def force_close_grpc_channel(channel: Any) -> None:
    core_channel = getattr(channel, "_channel", None)
    close = getattr(core_channel, "close", None)
    if callable(close):
        try:
            close()
        except Exception:
            pass


def force_close_active_grpc_channels() -> None:
    for channel in tuple(_ACTIVE_GRPC_CHANNELS):
        force_close_grpc_channel(channel)


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
    execution_token: str | None,
) -> None:
    await asyncio.to_thread(
        _persist_solved_schedule_sync,
        solve_payload,
        solved_shifts,
        job_id,
        retry_count,
        execution_token,
    )


def _persist_solved_schedule_sync(
    solve_payload: SolvePayload,
    solved_shifts: list[NormalizedShift],
    job_id: str | None,
    retry_count: int = 0,
    execution_token: str | None = None,
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
                lock_scheduling_mutations(cursor, solve_payload.tenant_id)
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
                    SELECT
                        job."status",
                        job."executionToken",
                        job."creditConsumption",
                        (SELECT COUNT(*)::integer FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."tenantId") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."amount") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."reason") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."balanceAfter") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT COUNT(*)::integer FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."tenantId") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."amount") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."reason") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."balanceAfter") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id")
                    FROM "ScheduleSolveJob" job
                    WHERE job."id" = %s
                      AND job."tenantId" = %s
                      AND job."scheduleId" = %s
                      AND job."locationId" = %s
                    FOR UPDATE
                    ''',
                    (
                        job_id,
                        solve_payload.tenant_id,
                        solve_payload.schedule_id,
                        solve_payload.location_id,
                    ),
                )
                job = cursor.fetchone()
                if not job:
                    raise NonRetryableJobError("schedule solve job not found")
                job_status = str(job[0])
                _assert_schedule_credit_provenance(
                    status=job_status,
                    credit_consumption=job[2],
                    tenant_id=solve_payload.tenant_id,
                    job_id=job_id,
                    debit_count=job[3],
                    debit_tenant_id=job[4],
                    debit_amount=job[5],
                    debit_reason=job[6],
                    debit_balance_after=job[7],
                    refund_count=job[8],
                    refund_tenant_id=job[9],
                    refund_amount=job[10],
                    refund_reason=job[11],
                    refund_balance_after=job[12],
                    error_type=NonRetryableJobError,
                )
                if job_status == "SUCCEEDED":
                    return
                if job_status in {"FAILED", "DEAD_LETTERED"}:
                    raise NonRetryableJobError("schedule solve job is already terminal")
                if not execution_token or str(job[1] or "") != execution_token:
                    raise ScheduleJobOwnershipLostError("schedule solve execution ownership was lost")

                cursor.execute(
                    'SELECT id FROM "User" WHERE "tenantId" = %s AND "deletedAt" IS NULL AND "suspendedAt" IS NULL AND role = ANY(%s::"UserRole"[]) AND id = ANY(%s) FOR UPDATE',
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
                    UPDATE "Schedule"
                    SET
                        "revision" = "revision" + 1,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "locationId" = %s
                      AND "status" = 'DRAFT'
                      AND "deletedAt" IS NULL
                      AND "revision" = %s
                    RETURNING "revision"
                    ''',
                    (
                        solve_payload.schedule_id,
                        solve_payload.tenant_id,
                        solve_payload.location_id,
                        solve_payload.draft_revision,
                    ),
                )
                revised_schedule = cursor.fetchone()
                if (
                    not revised_schedule
                    or int(revised_schedule[0]) != solve_payload.draft_revision + 1
                ):
                    raise NonRetryableJobError(
                        "draft changed before the solved result revision could be committed"
                    )

                cursor.execute(
                    '''
                    UPDATE "ScheduleSolveJob"
                    SET
                        "status" = 'SUCCEEDED',
                        "statusReason" = NULL,
                        "retryCount" = %s,
                        "resultShiftCount" = %s,
                        "executionToken" = NULL,
                        "executionLeaseUntil" = NULL,
                        "completedAt" = CURRENT_TIMESTAMP,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                      AND "status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
                      AND "executionToken" = %s
                    RETURNING "id"
                    ''',
                    (
                        retry_count,
                        len(solved_shifts),
                        job_id,
                        solve_payload.tenant_id,
                        solve_payload.schedule_id,
                        execution_token,
                    ),
                )
                if not cursor.fetchone():
                    raise ScheduleJobOwnershipLostError(
                        "schedule solve execution ownership was lost before completion"
                    )
    except (NonRetryableJobError, ScheduleJobOwnershipLostError):
        raise
    except Exception as exc:
        raise RetryableJobError("failed to persist solved schedule") from exc


async def handle_email_job(payload: dict[str, Any]) -> dict[str, Any]:
    outbox_id = required_payload_identifier(payload, "outbox_id", "email.send")
    try:
        return await dispatch_password_reset_email(outbox_id)
    except NonRetryableEmailError as exc:
        raise NonRetryableJobError("email delivery failed permanently") from exc
    except RetryableEmailError as exc:
        raise RetryableJobError("email delivery will be retried") from exc


async def handle_pdf_job(payload: dict[str, Any], retry_count: int = 0) -> dict[str, Any]:
    logger.info("Processing tenant-bound PDF availability import")
    try:
        return await process_availability_import(payload, retry_count)
    except AvailabilityImportRejected as exc:
        raise NonRetryableJobError("availability import was rejected") from exc
    except AvailabilityImportBusy as exc:
        raise ScheduleJobBusyError("availability import already has an active execution owner") from exc

async def handle_billing_sync(payload: dict[str, Any]) -> dict[str, Any]:
    logger.info("Processing billing sync job tenant_ref=%s", safe_ref(str(payload.get("tenant_id", ""))))
    try:
        return await dispatch_usage(payload)
    except NonRetryableBillingError as exc:
        raise NonRetryableJobError("billing delivery failed permanently") from exc
    except RetryableBillingError as exc:
        raise RetryableJobError("billing delivery will be retried") from exc


JOB_HANDLERS: dict[str, Callable[..., Awaitable[dict[str, Any]]]] = {
    "schedule.solve": handle_solve_job,
    "email.send": handle_email_job,
    "pdf.parse": handle_pdf_job,
    "billing.sync": handle_billing_sync,
}


async def process_message(body: bytes, message_id: str | None = None) -> dict[str, Any] | None:
    with TRACER.start_as_current_span("worker.process_job"):
        return await _process_message(body, message_id)


async def _process_message(body: bytes, message_id: str | None = None) -> dict[str, Any] | None:
    """Route one queue message to a handler after validation and durable ownership checks."""
    message = parse_job_message(body)
    job_type = message.type if message.type in JOB_HANDLERS else "unknown"
    solve_payload: SolvePayload | None = None
    execution_token: str | None = None
    start = time.perf_counter()
    IN_FLIGHT_JOBS.inc()
    try:
        handler = JOB_HANDLERS.get(message.type)
        if not handler:
            raise NonRetryableJobError(f"Unknown job type: {message.type}")

        if message.type == "schedule.solve":
            solve_payload = validate_solve_payload(message.payload)
            candidate_token = uuid.uuid4().hex
            claim_status = await claim_schedule_solve_job(
                solve_payload,
                message.job_id,
                message.retry_count,
                candidate_token,
            )
            if claim_status == "terminal":
                logger.info(
                    "Skipping terminal schedule solve job job_ref=%s status=%s",
                    safe_ref(message.job_id or ""),
                    claim_status,
                )
                JOB_TOTAL.labels(type=job_type, status="duplicate").inc()
                return {"skipped": True, "status": claim_status}
            if claim_status == "busy":
                raise ScheduleJobBusyError("schedule solve job already has an active execution owner")
            execution_token = candidate_token

        idempotency_key = job_key(message, message_id)
        if idempotency_key in _COMPLETED_JOB_KEYS:
            logger.info("Skipping duplicate completed job job_ref=%s", safe_ref(idempotency_key))
            JOB_TOTAL.labels(type=job_type, status="duplicate").inc()
            return {"skipped": True}

        if solve_payload:
            result = await handler(
                message.payload,
                message.job_id,
                message.retry_count,
                execution_token,
            )
        elif message.type == "pdf.parse":
            result = await handler(message.payload, message.retry_count)
        else:
            result = await handler(message.payload)
        remember_completed_job(idempotency_key)
        JOB_TOTAL.labels(type=job_type, status="success").inc()
        logger.info("Job completed type=%s", job_type)
        return result
    except ScheduleJobBusyError:
        JOB_TOTAL.labels(type=job_type, status="duplicate").inc()
        raise
    except NonRetryableJobError as exc:
        if solve_payload:
            await try_mark_schedule_solve_job_status(
                solve_payload,
                message.job_id,
                "FAILED",
                job_status_reason(exc),
                message.retry_count,
                execution_token,
            )
        JOB_TOTAL.labels(type=job_type, status="non_retryable").inc()
        raise
    except Exception as exc:
        if execution_token:
            setattr(exc, "schedule_execution_token", execution_token)
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


async def claim_schedule_solve_job(
    solve_payload: SolvePayload,
    job_id: str | None,
    retry_count: int,
    execution_token: str,
) -> str:
    if not os.getenv("DATABASE_URL"):
        return "claimed"
    if not job_id:
        raise NonRetryableJobError("schedule solve job id is required")
    return await asyncio.to_thread(
        _claim_schedule_solve_job_sync,
        solve_payload,
        job_id,
        retry_count,
        execution_token,
    )


def _claim_schedule_solve_job_sync(
    solve_payload: SolvePayload,
    job_id: str,
    retry_count: int,
    execution_token: str,
) -> str:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return "claimed"

    try:
        import psycopg
    except ImportError as exc:
        raise RetryableJobError("psycopg is required to update schedule job state") from exc

    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (solve_payload.tenant_id,))
                tenant = lock_scheduling_tenant_state(cursor, solve_payload.tenant_id)
                cursor.execute(
                    '''
                    SELECT
                        "status",
                        "executionToken",
                        "executionLeaseUntil",
                        "executionLeaseUntil" > CURRENT_TIMESTAMP,
                        job."creditConsumption",
                        (SELECT COUNT(*)::integer FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."tenantId") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."amount") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."reason") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT MIN(credit."balanceAfter") FROM "CreditTransaction" credit
                         WHERE credit."id" = 'schedule-credit-' || job."id"),
                        (SELECT COUNT(*)::integer FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."tenantId") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."amount") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."reason") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id"),
                        (SELECT MIN(refund."balanceAfter") FROM "CreditTransaction" refund
                         WHERE refund."id" = 'schedule-credit-refund-' || job."id")
                    FROM "ScheduleSolveJob" job
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                      AND "locationId" = %s
                    FOR UPDATE
                    ''',
                    (
                        job_id,
                        solve_payload.tenant_id,
                        solve_payload.schedule_id,
                        solve_payload.location_id,
                    ),
                )
                row = cursor.fetchone()
                if not row:
                    raise NonRetryableJobError("schedule solve job not found")
                status = str(row[0])
                _assert_schedule_credit_provenance(
                    status=status,
                    credit_consumption=row[4],
                    tenant_id=solve_payload.tenant_id,
                    job_id=job_id,
                    debit_count=row[5],
                    debit_tenant_id=row[6],
                    debit_amount=row[7],
                    debit_reason=row[8],
                    debit_balance_after=row[9],
                    refund_count=row[10],
                    refund_tenant_id=row[11],
                    refund_amount=row[12],
                    refund_reason=row[13],
                    refund_balance_after=row[14],
                    error_type=ScheduleCreditProvenanceError,
                )
                if status in SCHEDULE_JOB_TERMINAL_STATUSES:
                    return "terminal"
                require_active_paid_scheduling_tenant(tenant)
                if status == "RUNNING" and bool(row[3]) and str(row[1] or "") != execution_token:
                    return "busy"
                cursor.execute(
                    '''
                    UPDATE "ScheduleSolveJob"
                    SET
                        "status" = 'RUNNING',
                        "statusReason" = NULL,
                        "retryCount" = %s,
                        "executionToken" = %s,
                        "executionLeaseUntil" = CURRENT_TIMESTAMP + (%s * INTERVAL '1 second'),
                        "startedAt" = COALESCE("startedAt", CURRENT_TIMESTAMP),
                        "completedAt" = NULL,
                        "updatedAt" = CURRENT_TIMESTAMP
                    WHERE "id" = %s
                      AND "tenantId" = %s
                      AND "scheduleId" = %s
                    ''',
                    (
                        retry_count,
                        execution_token,
                        SCHEDULE_SOLVE_EXECUTION_LEASE_SECONDS,
                        job_id,
                        solve_payload.tenant_id,
                        solve_payload.schedule_id,
                    ),
                )
                return "claimed"
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
    execution_token: str | None = None,
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
        execution_token,
    )


async def terminalize_schedule_solve_job_by_id(
    job_id: str,
    status: str,
    reason: str,
    retry_count: int,
) -> None:
    if not os.getenv("DATABASE_URL"):
        return
    if not ID_RE.fullmatch(job_id):
        raise NonRetryableJobError("schedule solve job id is invalid")
    await asyncio.to_thread(
        _terminalize_schedule_solve_job_by_id_sync,
        job_id,
        status,
        reason,
        retry_count,
    )


def _assert_schedule_credit_provenance(
    *,
    status: str,
    credit_consumption: Any,
    tenant_id: str,
    job_id: str,
    debit_count: Any,
    debit_tenant_id: Any,
    debit_amount: Any,
    debit_reason: Any,
    debit_balance_after: Any,
    refund_count: Any,
    refund_tenant_id: Any,
    refund_amount: Any,
    refund_reason: Any,
    refund_balance_after: Any,
    error_type: type[Exception] = RetryableJobError,
) -> tuple[int, int]:
    if (
        not isinstance(credit_consumption, dict)
        or set(credit_consumption) != {"source", "consumedCredits", "newBalance"}
        or credit_consumption.get("source") != "credits"
        or type(credit_consumption.get("consumedCredits")) is not int
        or type(credit_consumption.get("newBalance")) is not int
    ):
        raise error_type("schedule solve paid credit reservation metadata is invalid")
    consumed_credits = credit_consumption["consumedCredits"]
    new_balance = credit_consumption["newBalance"]
    max_wallet_credits = 2_147_483_647
    if (
        consumed_credits <= 0
        or consumed_credits > max_wallet_credits
        or new_balance < 0
        or new_balance > max_wallet_credits
        or consumed_credits > max_wallet_credits - new_balance
    ):
        raise error_type("schedule solve paid credit reservation metadata is invalid")

    exact_debit = (
        _provenance_integer(debit_count) == 1
        and str(debit_tenant_id) == tenant_id
        and _provenance_integer(debit_amount) == -consumed_credits
        and str(debit_reason) == f"Schedule generation ({job_id})"
        and _provenance_integer(debit_balance_after) == new_balance
    )
    if not exact_debit:
        raise error_type("schedule solve paid credit reservation debit provenance is invalid")

    exact_refund = (
        _provenance_integer(refund_count) == 1
        and str(refund_tenant_id) == tenant_id
        and _provenance_integer(refund_amount) == consumed_credits
        and str(refund_reason) == f"Schedule generation refund ({job_id})"
        and _provenance_integer(refund_balance_after) is not None
        and _provenance_integer(refund_balance_after) >= 0
    )
    if status in {"FAILED", "DEAD_LETTERED"}:
        if not exact_refund:
            raise error_type("schedule solve refund provenance is invalid")
    elif status in {"QUEUED", "RUNNING", "RETRYING", "SUCCEEDED"}:
        if _provenance_integer(refund_count) != 0:
            raise error_type("schedule solve debit and deterministic refund cannot coexist")
    else:
        raise error_type("schedule solve status provenance is invalid")
    return consumed_credits, new_balance


def _provenance_integer(value: Any) -> int | None:
    if type(value) is int:
        return value
    return None


def _assert_schedule_refund_outcome(
    outcome: tuple[Any, ...] | None,
    tenant_id: str,
    job_id: str,
) -> None:
    if outcome is None or outcome[0] is None:
        raise ScheduleJobOwnershipLostError("schedule solve job no longer exists")

    initial_status = str(outcome[0])
    credit_consumption = outcome[1]
    debit_count = int(outcome[2])
    debit_tenant_id = str(outcome[3]) if outcome[3] is not None else None
    debit_amount = int(outcome[4]) if outcome[4] is not None else None
    debit_reason = str(outcome[5]) if outcome[5] is not None else None
    debit_balance_after = int(outcome[6]) if outcome[6] is not None else None
    refund_count = int(outcome[7])
    refund_tenant_id = str(outcome[8]) if outcome[8] is not None else None
    refund_amount = int(outcome[9]) if outcome[9] is not None else None
    refund_reason = str(outcome[10]) if outcome[10] is not None else None
    refund_balance_after = int(outcome[11]) if outcome[11] is not None else None
    updated_count = int(outcome[12])
    wallet_update_count = int(outcome[13])
    inserted_refund_count = int(outcome[14])
    inserted_refund_amount = int(outcome[15]) if outcome[15] is not None else None
    inserted_refund_balance_after = (
        int(outcome[16]) if outcome[16] is not None else None
    )

    consumed_credits, _debit_new_balance = _assert_schedule_credit_provenance(
        status=initial_status,
        credit_consumption=credit_consumption,
        tenant_id=tenant_id,
        job_id=job_id,
        debit_count=debit_count,
        debit_tenant_id=debit_tenant_id,
        debit_amount=debit_amount,
        debit_reason=debit_reason,
        debit_balance_after=debit_balance_after,
        refund_count=refund_count,
        refund_tenant_id=refund_tenant_id,
        refund_amount=refund_amount,
        refund_reason=refund_reason,
        refund_balance_after=refund_balance_after,
    )
    if initial_status in SCHEDULE_JOB_TERMINAL_STATUSES:
        return
    if updated_count != 1:
        raise ScheduleJobOwnershipLostError("schedule solve job execution ownership changed")
    if inserted_refund_count != 1 or wallet_update_count != 1:
        raise RetryableJobError("schedule solve refund settlement failed")
    if (
        inserted_refund_amount != consumed_credits
        or _provenance_integer(inserted_refund_balance_after) is None
        or inserted_refund_balance_after < 0
    ):
        raise RetryableJobError("schedule solve refund settlement balance is invalid")


def _terminalize_schedule_solve_job_with_refund(
    cursor: Any,
    solve_payload: SolvePayload | ScheduleSolveJobIdentity,
    job_id: str,
    status: str,
    safe_reason: str | None,
    retry_count: int,
    result_shift_count: int | None,
    execution_token: str | None,
) -> None:
    refund_id = f"schedule-credit-refund-{job_id}"
    refund_reason = f"Schedule generation refund ({job_id})"
    cursor.execute(
        '''
        WITH locked_job AS MATERIALIZED (
            SELECT
                job."id",
                job."tenantId",
                job."status",
                job."creditConsumption",
                CASE
                    WHEN jsonb_typeof(job."creditConsumption") = 'object'
                     AND job."creditConsumption" = jsonb_build_object(
                        'consumedCredits', job."creditConsumption"->'consumedCredits',
                        'newBalance', job."creditConsumption"->'newBalance',
                        'source', job."creditConsumption"->'source'
                     )
                     AND job."creditConsumption"->>'source' = 'credits'
                     AND jsonb_typeof(job."creditConsumption"->'consumedCredits') = 'number'
                     AND job."creditConsumption"->>'consumedCredits' ~ '^[1-9][0-9]*$'
                     AND jsonb_typeof(job."creditConsumption"->'newBalance') = 'number'
                     AND job."creditConsumption"->>'newBalance' ~ '^(0|[1-9][0-9]*)$'
                     AND (job."creditConsumption"->>'newBalance')::numeric <= 2147483647
                     AND (job."creditConsumption"->>'consumedCredits')::numeric
                         <= 2147483647 - (job."creditConsumption"->>'newBalance')::numeric
                    THEN CASE
                        WHEN (job."creditConsumption"->>'consumedCredits')::numeric <= 2147483647
                        THEN (job."creditConsumption"->>'consumedCredits')::integer
                        ELSE NULL
                    END
                    ELSE NULL
                END AS "configuredAmount"
            FROM "ScheduleSolveJob" job
            WHERE job."id" = %s
              AND job."tenantId" = %s
              AND job."scheduleId" = %s
              AND job."locationId" = %s
            FOR UPDATE
        ), debit_rows AS MATERIALIZED (
            SELECT
                debit."tenantId",
                debit."amount",
                debit."reason",
                debit."balanceAfter"
            FROM "CreditTransaction" debit
            JOIN locked_job job
              ON debit."id" = 'schedule-credit-' || job."id"
        ), refund_rows AS MATERIALIZED (
            SELECT
                refund."tenantId",
                refund."amount",
                refund."reason",
                refund."balanceAfter"
            FROM "CreditTransaction" refund
            JOIN locked_job job
              ON refund."id" = %s
        ), valid_provenance AS (
            SELECT job."id", job."tenantId", debit."amount" AS "debitAmount"
            FROM locked_job job
            JOIN debit_rows debit ON TRUE
            WHERE (SELECT COUNT(*) FROM debit_rows) = 1
              AND job."configuredAmount" IS NOT NULL
              AND debit."tenantId" = job."tenantId"
              AND debit."amount" = -job."configuredAmount"
              AND debit."reason" = 'Schedule generation (' || job."id" || ')'
              AND debit."balanceAfter" =
                  (job."creditConsumption"->>'newBalance')::integer
              AND (SELECT COUNT(*) FROM refund_rows) = 0
        ), updated_job AS (
            UPDATE "ScheduleSolveJob" job
            SET
                "status" = %s,
                "statusReason" = %s,
                "retryCount" = %s,
                "resultShiftCount" = %s,
                "executionToken" = NULL,
                "executionLeaseUntil" = NULL,
                "completedAt" = CURRENT_TIMESTAMP,
                "updatedAt" = CURRENT_TIMESTAMP
            FROM valid_provenance provenance
            WHERE job."id" = provenance."id"
              AND job."tenantId" = provenance."tenantId"
              AND job."status" NOT IN ('SUCCEEDED', 'FAILED', 'DEAD_LETTERED')
              AND CASE
                  WHEN %s::text IS NULL THEN
                      job."executionToken" IS NULL
                      OR job."executionLeaseUntil" <= CURRENT_TIMESTAMP
                  ELSE job."executionToken" = %s
              END
            RETURNING job."id", job."tenantId"
        ), updated_wallet AS (
            UPDATE "Tenant" tenant
            SET
                "usageCredits" = tenant."usageCredits" - provenance."debitAmount",
                "updatedAt" = CURRENT_TIMESTAMP
            FROM updated_job updated
            JOIN valid_provenance provenance ON provenance."id" = updated."id"
            WHERE tenant."id" = updated."tenantId"
            RETURNING
                tenant."id",
                tenant."usageCredits" AS "balanceAfter",
                -provenance."debitAmount" AS "refundAmount"
        ), inserted_refund AS (
            INSERT INTO "CreditTransaction"
                ("id", "tenantId", "amount", "reason", "balanceAfter", "createdAt")
            SELECT
                %s,
                wallet."id",
                wallet."refundAmount",
                %s,
                wallet."balanceAfter",
                CURRENT_TIMESTAMP
            FROM updated_wallet wallet
            RETURNING "tenantId", "amount", "balanceAfter"
        )
        SELECT
            (SELECT "status" FROM locked_job),
            (SELECT "creditConsumption" FROM locked_job),
            (SELECT COUNT(*)::integer FROM debit_rows),
            (SELECT MIN("tenantId") FROM debit_rows),
            (SELECT MIN("amount") FROM debit_rows),
            (SELECT MIN("reason") FROM debit_rows),
            (SELECT MIN("balanceAfter") FROM debit_rows),
            (SELECT COUNT(*)::integer FROM refund_rows),
            (SELECT MIN("tenantId") FROM refund_rows),
            (SELECT MIN("amount") FROM refund_rows),
            (SELECT MIN("reason") FROM refund_rows),
            (SELECT MIN("balanceAfter") FROM refund_rows),
            (SELECT COUNT(*)::integer FROM updated_job),
            (SELECT COUNT(*)::integer FROM updated_wallet),
            (SELECT COUNT(*)::integer FROM inserted_refund),
            (SELECT MIN("amount") FROM inserted_refund),
            (SELECT MIN("balanceAfter") FROM inserted_refund)
        ''',
        (
            job_id,
            solve_payload.tenant_id,
            solve_payload.schedule_id,
            solve_payload.location_id,
            refund_id,
            status,
            safe_reason,
            retry_count,
            result_shift_count,
            execution_token,
            execution_token,
            refund_id,
            refund_reason,
        ),
    )
    _assert_schedule_refund_outcome(
        cursor.fetchone(),
        solve_payload.tenant_id,
        job_id,
    )


def _terminalize_schedule_solve_job_by_id_sync(
    job_id: str,
    status: str,
    reason: str,
    retry_count: int,
) -> None:
    database_url = os.getenv("DATABASE_URL")
    if not database_url:
        return
    if status not in {"FAILED", "DEAD_LETTERED"}:
        raise ValueError("unsupported terminal schedule solve job status")
    capability = os.getenv("PLATFORM_ADMIN_DB_CONTEXT_SECRET", "").strip()
    if not capability:
        raise RetryableJobError(
            "PLATFORM_ADMIN_DB_CONTEXT_SECRET is required for authoritative schedule settlement"
        )

    try:
        import psycopg
    except ImportError as exc:
        raise RetryableJobError("psycopg is required to update schedule job state") from exc

    safe_reason = normalize_job_status_reason(reason)
    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute(
                    "SELECT set_current_platform_admin(true, %s)",
                    (capability,),
                )
                cursor.execute(
                    '''
                    SELECT "tenantId", "scheduleId", "locationId"
                    FROM "ScheduleSolveJob"
                    WHERE "id" = %s
                    ''',
                    (job_id,),
                )
                row = cursor.fetchone()
                if not row:
                    raise ScheduleJobOwnershipLostError("schedule solve job no longer exists")
                identity = ScheduleSolveJobIdentity(
                    tenant_id=str(row[0]),
                    schedule_id=str(row[1]),
                    location_id=str(row[2]),
                )
                cursor.execute("SELECT set_current_tenant(%s)", (identity.tenant_id,))
                lock_tenant_status(cursor, identity.tenant_id)
                _terminalize_schedule_solve_job_with_refund(
                    cursor,
                    identity,
                    job_id,
                    status,
                    safe_reason,
                    retry_count,
                    None,
                    None,
                )
    except (RetryableJobError, ScheduleJobOwnershipLostError):
        raise
    except Exception as exc:
        raise RetryableJobError(
            "failed to authoritatively terminalize schedule solve job"
        ) from exc


def _update_schedule_solve_job_status_sync(
    solve_payload: SolvePayload,
    job_id: str,
    status: str,
    reason: str | None,
    retry_count: int,
    result_shift_count: int | None,
    execution_token: str | None = None,
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
    safe_reason = None if status == "SUCCEEDED" else normalize_job_status_reason(reason)
    try:
        with psycopg.connect(database_url) as connection:
            with connection.cursor() as cursor:
                cursor.execute("SELECT set_current_tenant(%s)", (solve_payload.tenant_id,))
                lock_tenant_status(cursor, solve_payload.tenant_id)
                if status in {"FAILED", "DEAD_LETTERED"}:
                    _terminalize_schedule_solve_job_with_refund(
                        cursor,
                        solve_payload,
                        job_id,
                        status,
                        safe_reason,
                        retry_count,
                        result_shift_count,
                        execution_token,
                    )
                    return
                cursor.execute(
                    '''
                    UPDATE "ScheduleSolveJob"
                    SET
                        "status" = %s,
                        "statusReason" = %s,
                        "retryCount" = %s,
                        "resultShiftCount" = %s,
                        "executionToken" = NULL,
                        "executionLeaseUntil" = NULL,
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
                      AND CASE
                          WHEN %s::text IS NULL THEN
                              "executionToken" IS NULL
                              OR "executionLeaseUntil" <= CURRENT_TIMESTAMP
                          ELSE "executionToken" = %s
                      END
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
                        execution_token,
                        execution_token,
                    ),
                )
    except (RetryableJobError, ScheduleJobOwnershipLostError):
        raise
    except Exception as exc:
        raise RetryableJobError("failed to update schedule solve job status") from exc


def job_status_reason(exc: Exception) -> str:
    failure_class = sanitized_failure_class(exc)
    return JOB_STATUS_REASON_BY_FAILURE_CLASS.get(failure_class, INTERNAL_JOB_STATUS_REASON)


def normalize_job_status_reason(reason: str | None) -> str:
    if reason in JOB_STATUS_REASON_BY_FAILURE_CLASS.values():
        return reason
    return INTERNAL_JOB_STATUS_REASON


def normalize_solved_shifts(solve_payload: SolvePayload, response: Any) -> list[NormalizedShift]:
    try:
        schedule_start = parse_iso_datetime(solve_payload.start_date, "start_date")
        schedule_end = parse_iso_datetime(solve_payload.end_date, "end_date")
    except ValueError as exc:
        raise NonRetryableJobError("solve response contains invalid schedule bounds") from exc

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
            raise NonRetryableJobError("solve response contains invalid shift fields") from exc

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
            raise NonRetryableJobError("solve response contains invalid break fields") from exc

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


def optional_identifier(value: Any, field: str) -> str | None:
    if value is None:
        return None
    if not isinstance(value, str) or not ID_RE.fullmatch(value.strip()):
        raise NonRetryableJobError(f"{field} is invalid")
    return value.strip()


def required_payload_identifier(
    payload: dict[str, Any],
    field: str,
    job_type: str,
) -> str:
    value = optional_identifier(payload.get(field), field)
    if value is None:
        raise NonRetryableJobError(f"{job_type} requires an opaque {field}")
    return value


def job_key(message: JobMessage, message_id: str | None) -> str:
    generic_id = message.job_id or optional_identifier(message_id, "message_id")
    durable_id = ""
    if message.type == "email.send":
        durable_id = required_payload_identifier(message.payload, "outbox_id", message.type)
    elif message.type == "billing.sync":
        usage_event_id = optional_identifier(message.payload.get("usage_event_id"), "usage_event_id")
        if generic_id is None and usage_event_id is None:
            raise NonRetryableJobError(
                "billing.sync requires usage_event_id when job_id and message_id are absent"
            )
        durable_id = usage_event_id or ""

    raw_key = "|".join([
        message.type,
        generic_id or "",
        durable_id,
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


async def consume_queue(
    queue: Any,
    channel: Any,
    shutdown: ShutdownCoordinator | None = None,
) -> None:
    active_shutdown = shutdown or ShutdownCoordinator()
    if active_shutdown.event.is_set():
        return

    async with queue.iterator() as queue_iter:
        WORKER_READY.set(1)

        async def close_on_shutdown() -> None:
            await active_shutdown.event.wait()
            await queue_iter.close()

        close_task = asyncio.create_task(
            close_on_shutdown(),
            name="rabbitmq-consumer-stop",
        )
        try:
            async for message in queue_iter:
                if active_shutdown.event.is_set():
                    await message.nack(requeue=True)
                    break
                await handle_queue_message(channel, message)
                if active_shutdown.event.is_set():
                    break
            if not active_shutdown.event.is_set():
                raise RuntimeError("RabbitMQ consumer stopped unexpectedly")
        finally:
            WORKER_READY.set(0)
            if not close_task.done():
                close_task.cancel()
            done, _ = await asyncio.wait(
                {close_task},
                timeout=min(0.1, active_shutdown.remaining()),
            )
            if close_task in done and not close_task.cancelled():
                await close_task


@dataclass(frozen=True)
class SolverQueueTelemetry:
    ready: int
    retry: int
    dead_letter: int


def queue_message_count(queue: Any) -> int:
    message_count = getattr(getattr(queue, "declaration_result", None), "message_count", None)
    if isinstance(message_count, bool) or not isinstance(message_count, int) or message_count < 0:
        raise RuntimeError("RabbitMQ queue declaration did not return a valid message count")
    return message_count


def update_solver_queue_telemetry(telemetry: SolverQueueTelemetry) -> None:
    SOLVER_QUEUE_MESSAGES.labels(state="ready").set(telemetry.ready)
    SOLVER_QUEUE_MESSAGES.labels(state="retry").set(telemetry.retry)
    SOLVER_QUEUE_MESSAGES.labels(state="dead_letter").set(telemetry.dead_letter)
    SOLVER_QUEUE_DEPTH.set(telemetry.ready + telemetry.retry)
    SOLVER_QUEUE_TELEMETRY_AVAILABLE.set(1)


async def refresh_solver_queue_telemetry(channel: Any) -> SolverQueueTelemetry:
    try:
        ready_queue = await channel.declare_queue(QUEUE_NAME, passive=True)
        retry_depth = 0
        for retry_count in range(1, declared_retry_queue_count() + 1):
            retry_queue = await channel.declare_queue(
                retry_queue_name(retry_count),
                passive=True,
            )
            retry_depth += queue_message_count(retry_queue)
        dead_letter_queue = await channel.declare_queue(DLQ_NAME, passive=True)
        telemetry = SolverQueueTelemetry(
            ready=queue_message_count(ready_queue),
            retry=retry_depth,
            dead_letter=queue_message_count(dead_letter_queue),
        )
    except Exception:
        SOLVER_QUEUE_TELEMETRY_AVAILABLE.set(0)
        raise

    update_solver_queue_telemetry(telemetry)
    return telemetry


async def run_solver_queue_telemetry_loop(channel: Any) -> None:
    while True:
        try:
            await refresh_solver_queue_telemetry(channel)
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            logger.warning("Solver queue telemetry refresh failed reason=%s", exc.__class__.__name__)
        await asyncio.sleep(SOLVER_QUEUE_DEPTH_POLL_SECONDS)


async def run_worker_tasks(
    queue: Any,
    channel: Any,
    shutdown: ShutdownCoordinator | None = None,
) -> None:
    active_shutdown = shutdown or ShutdownCoordinator()
    consumer_task = asyncio.create_task(
        consume_queue(queue, channel, active_shutdown),
        name="rabbitmq-consumer",
    )
    queue_telemetry_task = asyncio.create_task(
        run_solver_queue_telemetry_loop(channel),
        name="solver-queue-telemetry-poll",
    )
    tasks = {
        consumer_task: "rabbitmq-consumer",
        queue_telemetry_task: "solver-queue-telemetry-poll",
    }
    parser_health_task = asyncio.create_task(
        run_pdf_parser_health_loop(),
        name="pdf-parser-health-poll",
    )
    tasks[parser_health_task] = "pdf-parser-health-poll"
    availability_retention_task = asyncio.create_task(
        run_availability_import_retention_loop(),
        name="availability-import-retention",
    )
    tasks[availability_retention_task] = "availability-import-retention"
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
    if staff_invitation_outbox_enabled():
        staff_invitation_task = asyncio.create_task(
            run_staff_invitation_outbox_loop(),
            name="staff-invitation-outbox-sweep",
        )
        tasks[staff_invitation_task] = "staff-invitation-outbox-sweep"

    def stop_on_unexpected_task_exit(task: asyncio.Task[Any]) -> None:
        if not active_shutdown.event.is_set():
            active_shutdown.request(f"required_task_stopped:{tasks[task]}")

    for task in tasks:
        task.add_done_callback(stop_on_unexpected_task_exit)

    shutdown_task = asyncio.create_task(
        active_shutdown.event.wait(),
        name="worker-shutdown-wait",
    )
    fatal_error: RuntimeError | None = None
    try:
        done, _ = await asyncio.wait(
            {*tasks, shutdown_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        stopped_task = next(
            (
                task
                for task, task_name in tasks.items()
                if active_shutdown.reason == f"required_task_stopped:{task_name}"
            ),
            None,
        )
        if (
            stopped_task is not None
            and stopped_task.done()
        ):
            task_name = tasks[stopped_task]
            if stopped_task.cancelled():
                fatal_error = RuntimeError(
                    f"Required background task stopped unexpectedly: {task_name}"
                )
            else:
                error = stopped_task.exception()
                if error is not None:
                    fatal_error = RuntimeError(
                        f"Required background task failed: {task_name}"
                    )
                    fatal_error.__cause__ = error
                else:
                    fatal_error = RuntimeError(
                        f"Required background task exited unexpectedly: {task_name}"
                    )

        for task in tasks:
            if task is not consumer_task and not task.done():
                task.cancel()

        done, pending = await asyncio.wait(
            tasks,
            timeout=active_shutdown.remaining(),
        )
        if pending:
            for task in pending:
                task.cancel()
            force_close_active_grpc_channels()
            names = ",".join(sorted(tasks[task] for task in pending))
            raise WorkerDrainTimeout(
                f"Worker drain deadline exceeded pending={names}"
            ) from fatal_error

        await asyncio.gather(*done, return_exceptions=True)
        if fatal_error is not None:
            raise fatal_error
    finally:
        if not shutdown_task.done():
            shutdown_task.cancel()
        done, _ = await asyncio.wait({shutdown_task}, timeout=0.1)
        if shutdown_task in done and not shutdown_task.cancelled():
            await shutdown_task


def force_close_rabbit_transport(connection: Any, channel: Any) -> None:
    candidates: list[Any] = [connection, channel]
    index = 0
    while index < len(candidates) and len(candidates) < 32:
        candidate = candidates[index]
        index += 1
        if candidate is None:
            continue
        for attribute in (
            "transport",
            "_transport",
            "connection",
            "_connection",
            "stream",
            "writer",
        ):
            nested = getattr(candidate, attribute, None)
            if nested is not None and not any(
                nested is existing for existing in candidates
            ):
                candidates.append(nested)

    seen: set[int] = set()
    for candidate in candidates:
        if candidate is None or id(candidate) in seen:
            continue
        seen.add(id(candidate))
        abort = getattr(candidate, "abort", None)
        if callable(abort):
            try:
                abort()
            except Exception:
                pass
        for attribute in ("socket", "_sock"):
            transport_socket = getattr(candidate, attribute, None)
            close = getattr(transport_socket, "close", None)
            if callable(close):
                try:
                    close()
                except Exception:
                    pass


async def close_rabbit_connection(
    connection: Any,
    channel: Any,
    shutdown: ShutdownCoordinator,
) -> None:
    close_task = asyncio.create_task(
        connection.close(),
        name="rabbitmq-connection-close",
    )
    done, pending = await asyncio.wait(
        {close_task},
        timeout=shutdown.remaining(),
    )
    if pending:
        close_task.cancel()
        force_close_rabbit_transport(connection, channel)
        raise WorkerDrainTimeout("RabbitMQ transport close exceeded worker deadline")
    try:
        await close_task
    except Exception:
        force_close_rabbit_transport(connection, channel)
        raise


async def start_consumer(shutdown: ShutdownCoordinator | None = None) -> None:
    """Connect to RabbitMQ and consume durable messages."""

    global _ACTIVE_RABBIT_CHANNEL, _ACTIVE_RABBIT_CONNECTION
    active_shutdown = shutdown or ShutdownCoordinator()

    try:
        import aio_pika
    except ImportError as exc:
        if ENVIRONMENT == "production":
            raise RuntimeError("aio-pika is required for the production worker") from exc
        logger.warning(
            "aio-pika not installed; standalone mode is allowed only outside production"
        )
        return

    connection: Any | None = None
    channel: Any | None = None
    try:
        connection = await aio_pika.connect_robust(RABBITMQ_URL)
        _ACTIVE_RABBIT_CONNECTION = connection
        channel = await connection.channel(publisher_confirms=True, on_return_raises=True)
        _ACTIVE_RABBIT_CHANNEL = channel
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
        await refresh_solver_queue_telemetry(channel)

        if active_shutdown.event.is_set():
            return

        logger.info("Worker connected to RabbitMQ queue=%s", QUEUE_NAME)
        await run_worker_tasks(queue, channel, active_shutdown)
    except Exception as exc:
        active_shutdown.request("rabbitmq_consumer_failure")
        logger.error(
            "RabbitMQ consumer failed operation=consumer_start failure_class=%s",
            sanitized_failure_class(exc),
        )
        raise
    finally:
        if connection is not None:
            if not active_shutdown.event.is_set():
                active_shutdown.request("rabbitmq_consumer_exit")
            try:
                await close_rabbit_connection(
                    connection,
                    channel,
                    active_shutdown,
                )
            finally:
                _ACTIVE_RABBIT_CHANNEL = None
                _ACTIVE_RABBIT_CONNECTION = None


async def handle_queue_message(channel: Any, message: Any) -> None:
    """Settle one source message only after durable replacement ownership is known."""
    try:
        await process_message(message.body, message_id=message.message_id)
    except ScheduleJobOwnershipLostError:
        logger.info("Stale schedule solve delivery discarded after ownership changed")
        await message.ack()
        return
    except ScheduleJobBusyError:
        retry_count = read_retry_count(message.body)
        try:
            await publish_retry(
                channel.default_exchange,
                message.body,
                retry_count,
                message.message_id,
            )
        except Exception as publish_error:
            logger.warning(
                "Busy schedule replacement publish failed; source will be requeued reason=%s",
                publish_error.__class__.__name__,
            )
            await asyncio.sleep(RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
            await message.nack(requeue=True)
            return
        logger.info("Busy schedule delivery delayed without consuming retry budget")
        await message.ack()
        return
    except NonRetryableJobError as exc:
        malformed_schedule_job_id = read_malformed_schedule_job_id(message.body)
        if malformed_schedule_job_id:
            try:
                await terminalize_schedule_solve_job_by_id(
                    malformed_schedule_job_id,
                    "DEAD_LETTERED",
                    job_status_reason(exc),
                    max(0, min(MAX_RETRIES, read_retry_count(message.body))),
                )
            except ScheduleJobOwnershipLostError:
                logger.info(
                    "Malformed stale schedule solve delivery discarded after ownership changed"
                )
                await message.ack()
                return
            except Exception as state_error:
                logger.error(
                    "Malformed schedule terminal settlement failed; source will be requeued operation=malformed_schedule_terminal_settlement failure_class=%s",
                    sanitized_failure_class(state_error),
                )
                await asyncio.sleep(RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
                await message.nack(requeue=True)
                return
        logger.warning("Non-retryable job routed to DLQ reason=%s", exc.__class__.__name__)
        await reject_to_solver_dlq(message, "non_retryable")
        return
    except asyncio.CancelledError:
        raise
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
                    "Terminal schedule state update failed; source will be requeued operation=terminal_schedule_state_update type=%s status=DEAD_LETTERED failure_class=%s",
                    job_type,
                    sanitized_failure_class(state_error),
                )
                await asyncio.sleep(RETRY_PUBLISH_FAILURE_REQUEUE_DELAY_SECONDS)
                await message.nack(requeue=True)
                return
            logger.error("Job exhausted retries and will route to DLQ type=%s", job_type)
            await reject_to_solver_dlq(message, "retries_exhausted")
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
                "Confirmed retry state update failed; replacement still owns delivery operation=retry_schedule_state_update type=%s status=RETRYING failure_class=%s",
                job_type,
                sanitized_failure_class(state_error),
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
    if message.type == "pdf.parse":
        await mark_import_retry(message.payload, status, retry_count, reason)
        return
    if message.type != "schedule.solve":
        return
    solve_payload = validate_solve_payload(message.payload)
    await try_mark_schedule_solve_job_status(
        solve_payload,
        message.job_id,
        status,
        job_status_reason(reason),
        retry_count,
        getattr(reason, "schedule_execution_token", None),
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


def read_malformed_schedule_job_id(body: bytes) -> str | None:
    if len(body) > MAX_MESSAGE_BYTES:
        return None
    try:
        raw = json.loads(body.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict) or raw.get("type") != "schedule.solve":
        return None
    job_id = raw.get("job_id")
    if not isinstance(job_id, str) or not ID_RE.fullmatch(job_id):
        return None
    try:
        message = JobMessage.model_validate(raw)
        validate_solve_payload(message.payload)
    except (ValidationError, NonRetryableJobError):
        return job_id
    return None


def retry_delay_ms(retry_count: int) -> int:
    index = max(0, min(retry_count - 1, len(RETRY_BACKOFF_SECONDS) - 1))
    return RETRY_BACKOFF_SECONDS[index] * 1000


def retry_queue_name(retry_count: int) -> str:
    index = max(1, min(retry_count, len(RETRY_BACKOFF_SECONDS)))
    return f"{RETRY_QUEUE_PREFIX}.{index}"


def declared_retry_queue_count() -> int:
    return max(1, min(MAX_RETRIES, len(RETRY_BACKOFF_SECONDS)))


async def declare_retry_queues(channel: Any) -> None:
    for retry_count in range(1, declared_retry_queue_count() + 1):
        await channel.declare_queue(
            retry_queue_name(retry_count),
            durable=True,
            arguments={
                "x-message-ttl": retry_delay_ms(retry_count),
                "x-dead-letter-exchange": "",
                "x-dead-letter-routing-key": QUEUE_NAME,
            },
        )


async def reject_to_solver_dlq(message: Any, reason: str) -> None:
    await message.reject(requeue=False)
    SOLVER_TERMINAL_TRANSITIONS.labels(reason=reason).inc()


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


def start_metrics_server() -> tuple[Any, threading.Thread] | None:
    global _METRICS_SERVER, _METRICS_STARTED, _METRICS_THREAD
    if _METRICS_STARTED:
        if _METRICS_SERVER is None or _METRICS_THREAD is None:
            return None
        return _METRICS_SERVER, _METRICS_THREAD
    port = int_env("WORKER_METRICS_PORT", 3003, 1, 65535)
    _METRICS_SERVER, _METRICS_THREAD = start_http_server(port)
    _METRICS_STARTED = True
    logger.info("Worker metrics endpoint started port=%s", port)
    return _METRICS_SERVER, _METRICS_THREAD


def force_close_metrics_server(server: Any) -> None:
    server_socket = getattr(server, "socket", None)
    if server_socket is None:
        return
    try:
        server_socket.shutdown(socket.SHUT_RDWR)
    except (OSError, ValueError):
        pass
    try:
        server_socket.close()
    except OSError:
        pass


async def stop_metrics_server(shutdown: ShutdownCoordinator) -> bool:
    global _METRICS_SERVER, _METRICS_STARTED, _METRICS_THREAD
    server = _METRICS_SERVER
    _METRICS_SERVER = None
    _METRICS_THREAD = None
    _METRICS_STARTED = False
    if server is None:
        return True

    mark_worker_unready()
    remaining = shutdown.remaining()
    if remaining <= 0:
        force_close_metrics_server(server)
        return False

    loop = asyncio.get_running_loop()
    stopped: asyncio.Future[None] = loop.create_future()

    def stop_server() -> None:
        error: BaseException | None = None
        try:
            server.shutdown()
            server.server_close()
        except BaseException as exc:
            error = exc
        try:
            if error is None:
                loop.call_soon_threadsafe(stopped.set_result, None)
            else:
                loop.call_soon_threadsafe(stopped.set_exception, error)
        except RuntimeError:
            pass

    threading.Thread(
        target=stop_server,
        name="worker-metrics-stop",
        daemon=True,
    ).start()
    done, pending = await asyncio.wait({stopped}, timeout=remaining)
    if pending:
        force_close_metrics_server(server)
        return False
    await stopped
    return True


def install_signal_handlers(
    shutdown: ShutdownCoordinator,
) -> Callable[[], None]:
    loop = asyncio.get_running_loop()
    previous_handlers: dict[signal.Signals, Any] = {}

    def handle_signal(signal_number: int, _frame: Any) -> None:
        signal_name = signal.Signals(signal_number).name.lower()
        loop.call_soon_threadsafe(
            shutdown.request,
            f"signal_{signal_name}",
            signal_number,
        )

    for runtime_signal in (signal.SIGTERM, signal.SIGINT):
        try:
            previous_handlers[runtime_signal] = signal.getsignal(runtime_signal)
            signal.signal(runtime_signal, handle_signal)
        except (OSError, RuntimeError, ValueError):
            previous_handlers.pop(runtime_signal, None)

    def restore() -> None:
        for runtime_signal, previous in previous_handlers.items():
            try:
                signal.signal(runtime_signal, previous)
            except (OSError, RuntimeError, ValueError):
                pass

    return restore


async def run_worker_runtime(
    shutdown: ShutdownCoordinator | None = None,
) -> int | None:
    active_shutdown = shutdown or ShutdownCoordinator()
    restore_signal_handlers = install_signal_handlers(active_shutdown)
    consumer_task: asyncio.Task[None] | None = None
    shutdown_task: asyncio.Task[bool] | None = None
    try:
        start_metrics_server()
        consumer_task = asyncio.create_task(
            start_consumer(active_shutdown),
            name="worker-consumer-runtime",
        )
        shutdown_task = asyncio.create_task(
            active_shutdown.event.wait(),
            name="worker-runtime-shutdown-wait",
        )
        done, _ = await asyncio.wait(
            {consumer_task, shutdown_task},
            return_when=asyncio.FIRST_COMPLETED,
        )
        if consumer_task not in done:
            drained, pending = await asyncio.wait(
                {consumer_task},
                timeout=active_shutdown.remaining(),
            )
            if pending:
                consumer_task.cancel()
                force_close_rabbit_transport(
                    _ACTIVE_RABBIT_CONNECTION,
                    _ACTIVE_RABBIT_CHANNEL,
                )
                force_close_active_grpc_channels()
                raise WorkerDrainTimeout("Worker runtime exceeded aggregate shutdown deadline")
            done = drained
        if consumer_task in done:
            await consumer_task
    finally:
        if not active_shutdown.event.is_set():
            active_shutdown.request("worker_runtime_exit")
        mark_worker_unready()
        if shutdown_task is not None and not shutdown_task.done():
            shutdown_task.cancel()
        if shutdown_task is not None:
            done, _ = await asyncio.wait({shutdown_task}, timeout=0.1)
            if shutdown_task in done and not shutdown_task.cancelled():
                await shutdown_task
        await stop_metrics_server(active_shutdown)
        restore_signal_handlers()
    return active_shutdown.signal_number


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
    validate_staff_invitation_outbox_config()
    validate_availability_import_config()


def shutdown_exit_code(
    shutdown: ShutdownCoordinator,
    fallback: int = 1,
) -> int:
    if shutdown.signal_number is None:
        return fallback
    return 128 + shutdown.signal_number


async def cancel_loop_tasks_with_deadline(
    tasks: set[asyncio.Task[Any]],
    timeout: float,
) -> bool:
    if not tasks:
        return True
    for task in tasks:
        task.cancel()
    done, pending = await asyncio.wait(tasks, timeout=timeout)
    await asyncio.gather(*done, return_exceptions=True)
    return not pending


def shutdown_executor_threads_with_deadline(
    loop: asyncio.AbstractEventLoop,
    shutdown: ShutdownCoordinator,
) -> bool:
    executor = getattr(loop, "_default_executor", None)
    if executor is None:
        return True
    executor.shutdown(wait=False, cancel_futures=True)
    threads = tuple(getattr(executor, "_threads", ()))
    for executor_thread in threads:
        executor_thread.join(timeout=shutdown.remaining())
        if shutdown.remaining() <= 0:
            break
    return not any(executor_thread.is_alive() for executor_thread in threads)


def run_worker_process() -> None:
    logger.info("Starting LunchLineup Worker")
    validate_runtime_config()
    shutdown = ShutdownCoordinator()
    loop = asyncio.new_event_loop()
    asyncio.set_event_loop(loop)
    signal_number: int | None = None
    failure: BaseException | None = None
    forced_exit_code: int | None = None
    try:
        signal_number = loop.run_until_complete(run_worker_runtime(shutdown))
    except WorkerDrainTimeout:
        forced_exit_code = shutdown_exit_code(shutdown)
    except BaseException as exc:
        failure = exc
    finally:
        pending_tasks = {
            task for task in asyncio.all_tasks(loop)
            if not task.done()
        }
        if forced_exit_code is None and pending_tasks:
            drained = loop.run_until_complete(
                cancel_loop_tasks_with_deadline(
                    pending_tasks,
                    shutdown.remaining(),
                )
            )
            if not drained:
                forced_exit_code = shutdown_exit_code(shutdown)
        if (
            forced_exit_code is None
            and not shutdown_executor_threads_with_deadline(loop, shutdown)
        ):
            forced_exit_code = shutdown_exit_code(shutdown)
        asyncio.set_event_loop(None)
        loop.close()
    if forced_exit_code is not None:
        force_close_rabbit_transport(
            _ACTIVE_RABBIT_CONNECTION,
            _ACTIVE_RABBIT_CHANNEL,
        )
        force_close_active_grpc_channels()
        if _METRICS_SERVER is not None:
            force_close_metrics_server(_METRICS_SERVER)
        os._exit(forced_exit_code)
    if failure is not None:
        raise failure
    if signal_number is not None:
        raise SystemExit(128 + signal_number)


if __name__ == "__main__":
    run_worker_process()
