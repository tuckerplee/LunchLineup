"""
LunchLineup scheduling engine.

The production path is gRPC-only for solve requests. HTTP remains for health,
metrics, and an explicitly enabled internal solve endpoint for development.
"""

from __future__ import annotations

from concurrent import futures
import hashlib
import json
import logging
import os
import time
from typing import Any, List

from fastapi import BackgroundTasks, FastAPI, HTTPException
from fastapi.responses import JSONResponse, Response
from opentelemetry import trace
from prometheus_client import CONTENT_TYPE_LATEST, Counter, Gauge, Histogram, generate_latest
from pydantic import BaseModel, ConfigDict, Field, ValidationError, field_validator

from src.solver.logic import ALLOWED_CONSTRAINTS, MAX_CONSTRAINTS, MAX_STAFF_IDS, ConstraintSolver
from src.telemetry import configure_tracing, extracted_context

configure_tracing("lunchlineup-engine")
TRACER = trace.get_tracer("lunchlineup.engine")

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

ENVIRONMENT = os.getenv("ENVIRONMENT", os.getenv("NODE_ENV", "development")).lower()
IS_PRODUCTION = ENVIRONMENT == "production"
GRPC_REQUIRED = os.getenv("ENGINE_GRPC_REQUIRED", "false").lower() in {"1", "true", "yes"}
HTTP_SOLVE_ENABLED = os.getenv("ENGINE_HTTP_SOLVE_ENABLED", "false").lower() in {"1", "true", "yes"}
ID_PATTERN = r"^[A-Za-z0-9._:@+-]{1,128}$"
GRPC_SERVER_READY = False

app = FastAPI(
    title="LunchLineup Scheduling Engine",
    version="1.0.0",
    docs_url=None if IS_PRODUCTION else "/docs",
    redoc_url=None if IS_PRODUCTION else "/redoc",
    openapi_url=None if IS_PRODUCTION else "/openapi.json",
)

SOLVER_REQUESTS = Counter(
    "lunchlineup_solver_requests_total",
    "Total number of schedule solve requests received",
    ["status"],
)

SOLVER_DURATION = Histogram(
    "lunchlineup_solver_duration_seconds",
    "Time taken to compute a schedule",
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0],
)

SOLVER_ERRORS = Counter(
    "lunchlineup_solver_errors_total",
    "Total number of solver failures or infeasible results",
    ["reason"],
)

ACTIVE_JOBS = Gauge(
    "lunchlineup_solver_active_jobs",
    "Number of solve jobs currently being processed",
)


class SolveRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    schedule_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    tenant_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    location_id: str = Field(..., min_length=1, max_length=128, pattern=ID_PATTERN)
    start_date: str = Field(..., min_length=8, max_length=40)
    end_date: str = Field(..., min_length=8, max_length=40)
    staff_ids: List[str] = Field(..., min_length=1, max_length=MAX_STAFF_IDS)
    constraints: dict[str, Any] = Field(default_factory=dict)

    @field_validator("staff_ids")
    @classmethod
    def validate_staff_ids(cls, value: List[str]) -> List[str]:
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
        if len(value) > MAX_CONSTRAINTS:
            raise ValueError(f"constraints cannot exceed {MAX_CONSTRAINTS} entries")
        unknown = set(value) - ALLOWED_CONSTRAINTS
        if unknown:
            raise ValueError(f"Unsupported constraint: {sorted(unknown)[0]}")
        if len(json.dumps(value, separators=(",", ":"))) > 16_384:
            raise ValueError("constraints payload is too large")
        return value


class SolveResult(BaseModel):
    schedule_id: str
    assignments: List[dict[str, Any]]
    score: float
    feasible: bool


@app.get("/health")
async def health():
    if GRPC_REQUIRED and not GRPC_SERVER_READY:
        return JSONResponse(
            status_code=503,
            content={"status": "unhealthy", "service": "engine", "grpc": "not_ready"},
        )
    return {"status": "healthy", "service": "engine"}


@app.get("/metrics")
async def metrics():
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)


@app.post("/solve")
async def solve_endpoint(request: SolveRequest, background_tasks: BackgroundTasks):
    if IS_PRODUCTION and not HTTP_SOLVE_ENABLED:
        raise HTTPException(status_code=404, detail="not found")
    background_tasks.add_task(process_solve_job, request)
    return {"job_id": request.schedule_id, "status": "QUEUED"}


async def process_solve_job(request: SolveRequest):
    run_solver(request)


def decode_constraint_value(value: str):
    """Restore primitive constraint types sent through string-only proto fields."""
    try:
        return json.loads(value)
    except (TypeError, json.JSONDecodeError):
        return value


def run_solver(request: SolveRequest, parent_context=None) -> dict[str, Any]:
    with TRACER.start_as_current_span(
        "engine.schedule_solve",
        context=parent_context,
        attributes={"schedule.staff_count": len(request.staff_ids)},
    ) as span:
        result = _run_solver(request)
        span.set_attribute("schedule.feasible", bool(result.get("feasible")))
        return result


def _run_solver(request: SolveRequest) -> dict[str, Any]:
    schedule_ref = safe_ref(request.schedule_id)
    logger.info("Processing solve job schedule_ref=%s", schedule_ref)
    start = time.perf_counter()
    ACTIVE_JOBS.inc()
    status_label = "failed"
    try:
        result = ConstraintSolver().solve(
            staff_ids=request.staff_ids,
            start_date=request.start_date,
            end_date=request.end_date,
            constraints=request.constraints,
        )
        status_label = "success" if result.get("feasible") else "failed"
        if not result.get("feasible"):
            SOLVER_ERRORS.labels(reason=classify_solver_reason(result.get("reason"))).inc()
        logger.info("Solve complete schedule_ref=%s feasible=%s", schedule_ref, result.get("feasible", False))
        return result
    except Exception:
        SOLVER_ERRORS.labels(reason="exception").inc()
        logger.exception("Unexpected solver failure schedule_ref=%s", schedule_ref)
        return {"assignments": [], "score": 0.0, "feasible": False, "reason": "Solver failed"}
    finally:
        SOLVER_REQUESTS.labels(status=status_label).inc()
        SOLVER_DURATION.observe(time.perf_counter() - start)
        ACTIVE_JOBS.dec()


def classify_solver_reason(reason: Any) -> str:
    text = str(reason or "").lower()
    if "unsupported" in text or "invalid" in text or "must" in text:
        return "validation"
    if "within" in text and "seconds" in text:
        return "timeout"
    return "infeasible"


def normalize_proto_break_type(value: Any) -> str:
    key = str(value or "LUNCH").strip().upper()
    if key == "MEAL":
        return "LUNCH"
    if key in {"BREAK1", "LUNCH", "BREAK2"}:
        return key
    return "LUNCH"


def safe_ref(value: str) -> str:
    return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]


def proto_to_solve_request(request: Any) -> SolveRequest:
    constraints = {c.type: decode_constraint_value(c.value) for c in request.constraints}
    staff_ids = []
    availability: dict[str, list[dict[str, str]]] = {}
    staff_skills: dict[str, list[str]] = {}
    existing_weekly_minutes: dict[str, dict[str, int]] = {}
    existing_shift_intervals: list[dict[str, str]] = []

    for staff in request.staff:
        staff_ids.append(staff.id)
        skills = [str(skill) for skill in getattr(staff, "skills", [])]
        if skills:
            staff_skills[staff.id] = skills
        rules = []
        for slot in staff.availability:
            rules.append({
                "day_of_week": slot.day_of_week,
                "start_time": slot.start_time,
                "end_time": slot.end_time,
            })
        configured = bool(getattr(staff, "availability_configured", False))
        if rules and not configured:
            raise ValueError("staff availability rules require availability_configured")
        availability[staff.id] = rules

    if availability:
        if "availability" in constraints:
            raise ValueError("availability can only be supplied through staff availability")
        constraints["availability"] = availability

    if staff_skills:
        if "staff_skills" in constraints:
            raise ValueError("staff_skills can only be supplied through staff skills")
        constraints["staff_skills"] = staff_skills

    for entry in getattr(request, "existing_weekly_minutes", []):
        staff_weeks = existing_weekly_minutes.setdefault(str(entry.staff_id), {})
        week_start = str(entry.week_start_date)
        if week_start in staff_weeks:
            raise ValueError("duplicate existing weekly minutes entry")
        staff_weeks[week_start] = int(entry.minutes)
    if existing_weekly_minutes:
        if "existing_weekly_minutes" in constraints:
            raise ValueError("existing_weekly_minutes can only be supplied through its request field")
        constraints["existing_weekly_minutes"] = existing_weekly_minutes

    for entry in getattr(request, "existing_shifts", []):
        existing_shift_intervals.append({
            "id": str(entry.id),
            "staff_id": str(entry.staff_id),
            "location_id": str(entry.location_id),
            "start_time": str(entry.start_time),
            "end_time": str(entry.end_time),
        })
    if existing_shift_intervals:
        if "existing_shift_intervals" in constraints:
            raise ValueError("existing_shift_intervals can only be supplied through existing shifts")
        constraints["existing_shift_intervals"] = existing_shift_intervals

    return SolveRequest.model_validate({
        "schedule_id": request.schedule_id,
        "tenant_id": request.tenant_id,
        "location_id": request.location_id,
        "start_date": request.start_date,
        "end_date": request.end_date,
        "staff_ids": staff_ids,
        "constraints": constraints,
    })


def int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


def bind_and_start_grpc_server(server: Any, bind_address: str) -> int:
    """Bind and start gRPC, publishing readiness only after both operations succeed."""
    global GRPC_SERVER_READY
    GRPC_SERVER_READY = False
    bound_port = server.add_insecure_port(bind_address)
    if bound_port == 0:
        raise RuntimeError(f"gRPC server could not bind to {bind_address}")
    try:
        server.start()
    except Exception:
        GRPC_SERVER_READY = False
        raise
    GRPC_SERVER_READY = True
    return bound_port


def start_grpc_server():
    """
    Start the gRPC server for internal inter-service scheduling calls.
    """
    try:
        import grpc
        import solver_pb2
        import solver_pb2_grpc

        class SolverServicer(solver_pb2_grpc.SolverServiceServicer):
            def CalculateSchedule(self, request, context):
                try:
                    solve_request = proto_to_solve_request(request)
                except (ValidationError, ValueError):
                    context.abort(grpc.StatusCode.INVALID_ARGUMENT, "invalid schedule request")

                result = run_solver(solve_request, extracted_context(context.invocation_metadata()))
                response = solver_pb2.ScheduleResponse()
                response.schedule_id = solve_request.schedule_id
                response.status = "SUCCESS" if result.get("feasible") else "FAILED"
                if not result.get("feasible"):
                    response.reason = result.get("reason", "No feasible solution found under constraints")
                    if hasattr(response, "infeasible_details"):
                        for detail in result.get("details", []):
                            pb_detail = response.infeasible_details.add()
                            pb_detail.code = str(detail.get("code", "infeasible"))
                            pb_detail.message = str(detail.get("message", "No feasible solution found"))
                            pb_detail.date = str(detail.get("date", ""))
                            pb_detail.skill = str(detail.get("skill", ""))
                            pb_detail.required = int(detail.get("required", 0) or 0)
                            pb_detail.available = int(detail.get("available", 0) or 0)

                for assign in result.get("assignments", []):
                    shift = response.shifts.add()
                    shift.staff_id = assign["staff_id"]
                    shift.start_time = assign["start_time"]
                    shift.end_time = assign["end_time"]
                    shift.role = str(assign.get("role") or "STAFF")

                    for schedule_break in assign.get("breaks", []):
                        pb_break = shift.breaks.add()
                        pb_break.start_time = schedule_break["start_time"]
                        pb_break.end_time = schedule_break["end_time"]
                        pb_break.paid = schedule_break["paid"]
                        pb_break.type = normalize_proto_break_type(schedule_break.get("type"))

                return response

        max_workers = int_env("ENGINE_GRPC_MAX_WORKERS", 10, 1, 50)
        bind_address = os.getenv("ENGINE_GRPC_BIND", "[::]:50051")
        server = grpc.server(futures.ThreadPoolExecutor(max_workers=max_workers))
        solver_pb2_grpc.add_SolverServiceServicer_to_server(SolverServicer(), server)
        bound_port = bind_and_start_grpc_server(server, bind_address)
        logger.info(
            "gRPC server started bind=%s bound_port=%s max_workers=%s",
            bind_address,
            bound_port,
            max_workers,
        )
        return server
    except ImportError as e:
        if GRPC_REQUIRED:
            raise
        logger.warning("gRPC dependencies not installed or proto files missing; running HTTP-only mode: %s", e)
        return None


if __name__ == "__main__":
    import uvicorn

    grpc_server = start_grpc_server()
    uvicorn.run(app, host=os.getenv("ENGINE_HTTP_HOST", "0.0.0.0"), port=int_env("ENGINE_HTTP_PORT", 8000, 1, 65535), log_level="info")
