"""OpenTelemetry bootstrap and propagation helpers for the worker."""

from __future__ import annotations

import atexit
import os
from typing import Iterable

from opentelemetry import propagate, trace
from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
from opentelemetry.sdk.resources import Resource
from opentelemetry.sdk.trace import TracerProvider
from opentelemetry.sdk.trace.export import BatchSpanProcessor

_provider: TracerProvider | None = None


def configure_tracing(service_name: str) -> bool:
    """Configure queued OTLP export when an endpoint is explicitly supplied."""
    global _provider
    if _provider is not None:
        return True
    endpoint = os.getenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", "").strip()
    if not endpoint:
        return False

    resource = Resource.create({
        "service.name": service_name,
        "deployment.environment.name": os.getenv("OTEL_DEPLOYMENT_ENVIRONMENT", os.getenv("ENVIRONMENT", "development")),
    })
    provider = TracerProvider(resource=resource)
    provider.add_span_processor(BatchSpanProcessor(
        OTLPSpanExporter(endpoint=endpoint, timeout=5),
        max_queue_size=2048,
        schedule_delay_millis=5000,
        export_timeout_millis=5000,
    ))
    trace.set_tracer_provider(provider)
    _provider = provider
    atexit.register(provider.shutdown)
    return True


def current_trace_metadata() -> tuple[tuple[str, str], ...]:
    carrier: dict[str, str] = {}
    propagate.inject(carrier)
    return tuple(carrier.items())


def extracted_context(metadata: Iterable[tuple[str, str]]):
    return propagate.extract(dict(metadata))
