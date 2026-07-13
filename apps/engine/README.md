# Engine Service

This folder contains the Python scheduling engine and its CI test dependencies. Persisted demand windows are split at every overlap boundary, then solved with maximum total demand and independent per-skill maxima so qualified workers count toward both general and matching skill coverage as they do at publish time. Tenant-wide existing shift intervals make conflicting staff unavailable before persistence, while existing weekly minutes remain a separate hour-limit input. The scheduling API requires persisted exact demand instead of silently invoking the legacy daily fallback.

When `ENGINE_GRPC_REQUIRED=true`, `/health` returns `503` until the scheduling gRPC server has successfully bound and started. A zero result from `add_insecure_port` is a startup failure, so Compose cannot mark an engine healthy when the worker's RPC path is unavailable.

## Files

- `README.md`: this folder guide.
- `main.py`: FastAPI entrypoint for the engine service.
- `pytest.ini`: PyTest configuration used by CI.
- `requirements.txt`: Python runtime and test dependencies for the engine service.

## Folders

- `src/`: engine implementation modules.
- `tests/`: engine unit tests.

## CI Command

The Stage 5 unit job uses Python 3.12, installs `requirements.txt`, and runs:

```bash
python -m pytest --cov=src --cov-fail-under=90
```

`ortools` is required for `ConstraintSolver`; keep it pinned with compatible `grpcio-tools` and `protobuf` versions in `requirements.txt` so solver tests are reproducible in CI.
