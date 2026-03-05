"""
LunchLineup Scheduling Engine — FastAPI + gRPC Server.
Architecture Part VIII — gRPC-only internal communication, HTTP only for health checks.
"""

import os
import asyncio
import logging
from fastapi import FastAPI, BackgroundTasks
from pydantic import BaseModel
from typing import List, Optional
from concurrent import futures

from prometheus_client import Counter, Histogram, Gauge, generate_latest, CONTENT_TYPE_LATEST

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI(title="LunchLineup Scheduling Engine", version="1.0.0")

# ─── Prometheus Metrics ───────────────────────────────────────────────────────

SOLVER_REQUESTS = Counter(
    'lunchlineup_solver_requests_total',
    'Total number of schedule solve requests received',
    ['tenant_id', 'status']
)

SOLVER_DURATION = Histogram(
    'lunchlineup_solver_duration_seconds',
    'Time taken to compute a schedule',
    buckets=[0.1, 0.5, 1.0, 2.0, 5.0, 10.0, 30.0]
)

SOLVER_ERRORS = Counter(
    'lunchlineup_solver_errors_total',
    'Total number of solver failures or infeasible results',
    ['reason']
)

ACTIVE_JOBS = Gauge(
    'lunchlineup_solver_active_jobs',
    'Number of solve jobs currently being processed'
)

# ─── Health Check (only HTTP endpoint) ───

@app.get("/health")
async def health():
    return {"status": "healthy", "service": "engine"}

@app.get("/metrics")
async def metrics():
    """Prometheus-compatible plaintext metrics endpoint."""
    from fastapi.responses import Response
    return Response(content=generate_latest(), media_type=CONTENT_TYPE_LATEST)

# ─── Job Queue Consumer (RabbitMQ) ───

class SolveRequest(BaseModel):
    schedule_id: str
    tenant_id: str
    location_id: str
    start_date: str
    end_date: str
    staff_ids: List[str]
    constraints: dict = {}

class SolveResult(BaseModel):
    schedule_id: str
    assignments: List[dict]
    score: float
    feasible: bool

@app.post("/solve")
async def solve_endpoint(request: SolveRequest, background_tasks: BackgroundTasks):
    """
    Accept a solve request (internal only — should come via gRPC in production).
    Queues the job for background processing.
    """
    background_tasks.add_task(process_solve_job, request)
    return {"job_id": request.schedule_id, "status": "QUEUED"}

async def process_solve_job(request: SolveRequest):
    """Process a scheduling optimization request."""
    from src.solver.logic import ConstraintSolver, BreakCalculator

    logger.info(f"Processing solve job: schedule={request.schedule_id}")

    solver = ConstraintSolver()
    result = solver.solve(
        staff_ids=request.staff_ids,
        start_date=request.start_date,
        end_date=request.end_date,
        constraints=request.constraints,
    )

    logger.info(f"Solve complete: schedule={request.schedule_id} feasible={result.get('feasible', False)}")
    # In production: publish result back via RabbitMQ or gRPC callback

# ─── gRPC Server ───

def start_grpc_server():
    """
    Start the gRPC server for inter-service communication.
    Architecture Part VIII — Engine is gRPC-only for internal calls.
    """
    try:
        import grpc
        from concurrent import futures
        from src.solver import solver_pb2, solver_pb2_grpc
        from src.solver.logic import ConstraintSolver

        class SolverServicer(solver_pb2_grpc.SolverServiceServicer):
            def CalculateSchedule(self, request, context):
                logger.info(f"gRPC solve request for schedule_id={request.tenant_id}-{request.location_id}")
                solver = ConstraintSolver()
                
                # Transform proto objects to dict/list for logic.py
                staff_ids = [s.id for s in request.staff]
                constraints_dict = {c.type: c.value for c in request.constraints}
                
                result = solver.solve(
                    staff_ids=staff_ids,
                    start_date=request.start_date,
                    end_date=request.end_date,
                    constraints=constraints_dict,
                )
                
                response = solver_pb2.ScheduleResponse()
                response.schedule_id = f"gen-{request.tenant_id}-{request.location_id}"
                response.status = "SUCCESS" if result.get("feasible") else "FAILED"
                
                for assign in result.get("assignments", []):
                    shift = response.shifts.add()
                    shift.staff_id = assign["staff_id"]
                    shift.start_time = assign["start_time"]
                    shift.end_time = assign["end_time"]
                    shift.role = "STAFF"
                    
                    for b in assign.get("breaks", []):
                        pb_break = shift.breaks.add()
                        pb_break.start_time = b["start_time"]
                        pb_break.end_time = b["end_time"]
                        pb_break.paid = b["paid"]
                        
                return response

        server = grpc.server(futures.ThreadPoolExecutor(max_workers=10))
        solver_pb2_grpc.add_SolverServiceServicer_to_server(SolverServicer(), server)
        server.add_insecure_port('[::]:50051')
        server.start()
        logger.info("gRPC server started on port 50051")
        return server
    except ImportError as e:
        logger.warning(f"gRPC dependencies not installed or proto files missing — running HTTP-only mode: {e}")
        return None

if __name__ == "__main__":
    import uvicorn

    # Start gRPC server in background
    grpc_server = start_grpc_server()

    # Start HTTP health check server
    uvicorn.run(app, host="0.0.0.0", port=8000, log_level="info")
