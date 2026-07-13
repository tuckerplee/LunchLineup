"""Runtime readiness tests for the engine's required gRPC scheduling path."""

import asyncio
from types import SimpleNamespace

import pytest

import main


class FakeGrpcServer:
    def __init__(self, bound_port=50051, start_error=None):
        self.bound_port = bound_port
        self.start_error = start_error
        self.started = False

    def add_insecure_port(self, _bind_address):
        return self.bound_port

    def start(self):
        if self.start_error:
            raise self.start_error
        self.started = True


@pytest.fixture(autouse=True)
def reset_grpc_readiness(monkeypatch):
    monkeypatch.setattr(main, "GRPC_SERVER_READY", False)
    monkeypatch.setattr(main, "GRPC_REQUIRED", True)


def test_bind_failure_raises_and_keeps_engine_unready():
    server = FakeGrpcServer(bound_port=0)

    with pytest.raises(RuntimeError, match="could not bind"):
        main.bind_and_start_grpc_server(server, "[::]:50051")

    assert server.started is False
    assert main.GRPC_SERVER_READY is False


def test_start_failure_keeps_engine_unready():
    server = FakeGrpcServer(start_error=RuntimeError("start failed"))

    with pytest.raises(RuntimeError, match="start failed"):
        main.bind_and_start_grpc_server(server, "[::]:50051")

    assert main.GRPC_SERVER_READY is False


def test_successful_bind_and_start_publishes_readiness():
    server = FakeGrpcServer()

    bound_port = main.bind_and_start_grpc_server(server, "[::]:50051")

    assert bound_port == 50051
    assert server.started is True
    assert main.GRPC_SERVER_READY is True


def test_required_grpc_health_is_unavailable_until_ready():
    response = asyncio.run(main.health())

    assert response.status_code == 503
    assert b'"grpc":"not_ready"' in response.body

    main.bind_and_start_grpc_server(FakeGrpcServer(), "[::]:50051")
    assert asyncio.run(main.health()) == {"status": "healthy", "service": "engine"}


def test_optional_http_only_mode_remains_healthy(monkeypatch):
    monkeypatch.setattr(main, "GRPC_REQUIRED", False)

    assert asyncio.run(main.health()) == {"status": "healthy", "service": "engine"}


def test_proto_maps_existing_weekly_minutes_into_solver_constraints():
    request = SimpleNamespace(
        schedule_id="sch-1",
        tenant_id="tenant-1",
        location_id="loc-1",
        start_date="2026-03-09T00:00:00Z",
        end_date="2026-03-10T00:00:00Z",
        constraints=[],
        staff=[SimpleNamespace(
            id="u1",
            skills=[],
            availability=[],
            availability_configured=False,
        )],
        existing_weekly_minutes=[SimpleNamespace(
            staff_id="u1",
            week_start_date="2026-03-09",
            minutes=360,
        )],
        existing_shifts=[SimpleNamespace(
            id="shift-existing",
            staff_id="u1",
            location_id="loc-2",
            start_time="2026-03-09T18:00:00Z",
            end_time="2026-03-09T20:00:00Z",
        )],
    )

    solve_request = main.proto_to_solve_request(request)

    assert solve_request.constraints["existing_weekly_minutes"] == {
        "u1": {"2026-03-09": 360},
    }
    assert solve_request.constraints["availability"] == {"u1": []}
    assert solve_request.constraints["existing_shift_intervals"] == [{
        "id": "shift-existing",
        "staff_id": "u1",
        "location_id": "loc-2",
        "start_time": "2026-03-09T18:00:00Z",
        "end_time": "2026-03-09T20:00:00Z",
    }]
