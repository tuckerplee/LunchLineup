# Engine Service

This folder contains the Python scheduling engine and its CI test dependencies.

## Files

- `README.md`: this folder guide.
- `main.py`: FastAPI entrypoint for the engine service.
- `pytest.ini`: PyTest configuration used by CI.
- `requirements.txt`: Python runtime and test dependencies for the engine service.
- `src/solver/logic.py`: schedule solver logic.
- `tests/test_solver.py`: engine unit tests for solver behavior.

## CI Command

The Stage 5 unit job uses Python 3.12, installs `requirements.txt`, and runs:

```bash
python -m pytest --cov=src --cov-fail-under=90
```

`ortools` is required for `ConstraintSolver`; keep it pinned in `requirements.txt` so solver tests are reproducible in CI.
