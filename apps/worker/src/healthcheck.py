from __future__ import annotations

import http.client
import math
import os
import time


def _enabled(name: str) -> bool:
    return os.getenv(name, "false").strip().lower() == "true"


def _metric_values(payload: str) -> dict[str, float]:
    values: dict[str, float] = {}
    for raw_line in payload.splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#"):
            continue
        parts = line.split()
        if len(parts) < 2 or "{" in parts[0]:
            continue
        try:
            value = float(parts[1])
        except ValueError:
            continue
        if math.isfinite(value):
            values[parts[0]] = value
    return values


def _require(values: dict[str, float], name: str, expected: float) -> None:
    if values.get(name) != expected:
        raise RuntimeError(f"worker health metric is not ready: {name}")


def _require_fresh(values: dict[str, float], prefix: str, max_age_seconds: int, now: float) -> None:
    last_success = values.get(f"{prefix}_sweep_last_success_unixtime", 0)
    age = now - last_success
    if last_success <= 0 or age < 0 or age > max_age_seconds:
        raise RuntimeError(f"worker health sweep is stale: {prefix}")


def check(payload: str, *, now: float | None = None) -> None:
    values = _metric_values(payload)
    _require(values, "lunchlineup_pdf_parser_ready", 1)
    current_time = time.time() if now is None else now
    for enabled_name, prefix, max_age_name in (
        (
            "PASSWORD_RESET_EMAIL_OUTBOX_ENABLED",
            "lunchlineup_password_reset_email",
            "PASSWORD_RESET_EMAIL_SWEEP_MAX_STALENESS_SECONDS",
        ),
        (
            "STAFF_INVITATION_OUTBOX_ENABLED",
            "lunchlineup_staff_invitation",
            "STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS",
        ),
    ):
        if not _enabled(enabled_name):
            continue
        _require(values, f"{prefix}_sweep_running", 1)
        _require(values, f"{prefix}_sweep_ready", 1)
        _require(values, f"{prefix}_systemic_provider_failure", 0)
        max_age = int(os.getenv(max_age_name, "60"))
        _require_fresh(values, prefix, max_age, current_time)


def main() -> None:
    port = int(os.getenv("WORKER_METRICS_PORT", "3003"))
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=3)
    try:
        connection.request("GET", "/metrics", headers={"Host": "127.0.0.1"})
        response = connection.getresponse()
        if response.status != 200:
            raise RuntimeError("worker metrics endpoint is unavailable")
        payload_bytes = response.read(2_000_001)
        if len(payload_bytes) > 2_000_000:
            raise RuntimeError("worker metrics payload exceeds the healthcheck limit")
        payload = payload_bytes.decode("utf-8", errors="strict")
    finally:
        connection.close()
    check(payload)


if __name__ == "__main__":
    main()
