"""Runtime readiness monitoring for the isolated availability PDF parser."""

from __future__ import annotations

import asyncio
import logging
import os
import subprocess
import sys

from prometheus_client import Counter, Gauge


logger = logging.getLogger("worker.parser-health")


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


def _bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))


PDF_PARSER_HEALTH_POLL_SECONDS = _bounded_int(
    "WORKER_PDF_PARSER_HEALTH_POLL_SECONDS", 10, 5, 60
)
PDF_PARSER_HEALTH_TIMEOUT_SECONDS = _bounded_float(
    "WORKER_PDF_PARSER_HEALTH_TIMEOUT_SECONDS", 3.0, 1.0, 10.0
)
PDF_PARSER_READY = Gauge(
    "lunchlineup_pdf_parser_ready",
    "Whether the isolated availability PDF parser answered its worker-side health probe",
)
PDF_PARSER_HEALTH_FAILURES = Counter(
    "lunchlineup_pdf_parser_health_probe_failures_total",
    "Failed worker-side health probes to the isolated availability PDF parser",
)


def check_pdf_parser_health() -> bool:
    environment = {
        "PATH": os.getenv("PATH", ""),
        "PYTHONPATH": os.getenv("PYTHONPATH", ""),
        "PARSER_SOCKET_PATH": os.getenv(
            "PARSER_SOCKET_PATH", "/run/lunchlineup-parser/parser.sock"
        ),
    }
    try:
        result = subprocess.run(
            [sys.executable, "-m", "src.parser.pdf_sandbox", "--health"],
            check=False,
            close_fds=True,
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL,
            timeout=PDF_PARSER_HEALTH_TIMEOUT_SECONDS,
        )
    except (OSError, subprocess.TimeoutExpired):
        return False
    return result.returncode == 0


async def refresh_pdf_parser_health() -> bool:
    ready = await asyncio.to_thread(check_pdf_parser_health)
    PDF_PARSER_READY.set(1 if ready else 0)
    if not ready:
        PDF_PARSER_HEALTH_FAILURES.inc()
    return ready


async def run_pdf_parser_health_loop() -> None:
    previous_ready: bool | None = None
    while True:
        try:
            ready = await refresh_pdf_parser_health()
        except asyncio.CancelledError:
            raise
        except Exception:
            ready = False
            PDF_PARSER_READY.set(0)
            PDF_PARSER_HEALTH_FAILURES.inc()
        if ready != previous_ready:
            logger.log(
                logging.INFO if ready else logging.ERROR,
                "Isolated PDF parser readiness changed ready=%s",
                ready,
            )
            previous_ready = ready
        await asyncio.sleep(PDF_PARSER_HEALTH_POLL_SECONDS)
