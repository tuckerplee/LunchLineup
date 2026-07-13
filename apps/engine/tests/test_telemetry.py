"""Tests for optional OpenTelemetry bootstrap and context propagation."""

from src import telemetry


def test_configure_tracing_stays_disabled_without_an_endpoint(monkeypatch):
    monkeypatch.setattr(telemetry, "_provider", None)
    monkeypatch.delenv("OTEL_EXPORTER_OTLP_TRACES_ENDPOINT", raising=False)

    assert telemetry.configure_tracing("engine-test") is False
    assert telemetry._provider is None


def test_configure_tracing_is_idempotent(monkeypatch):
    existing_provider = object()
    monkeypatch.setattr(telemetry, "_provider", existing_provider)

    assert telemetry.configure_tracing("engine-test") is True
    assert telemetry._provider is existing_provider


def test_configure_tracing_builds_and_registers_the_provider(monkeypatch):
    calls = {}

    class FakeResource:
        @staticmethod
        def create(attributes):
            calls["resource"] = attributes
            return attributes

    class FakeExporter:
        def __init__(self, **kwargs):
            calls["exporter"] = kwargs

    class FakeProcessor:
        def __init__(self, exporter, **kwargs):
            calls["processor"] = {"exporter": exporter, **kwargs}

    class FakeProvider:
        def __init__(self, resource):
            calls["provider_resource"] = resource
            self.processors = []

        def add_span_processor(self, processor):
            self.processors.append(processor)

        def shutdown(self):
            return None

    monkeypatch.setattr(telemetry, "_provider", None)
    monkeypatch.setattr(telemetry, "Resource", FakeResource)
    monkeypatch.setattr(telemetry, "OTLPSpanExporter", FakeExporter)
    monkeypatch.setattr(telemetry, "BatchSpanProcessor", FakeProcessor)
    monkeypatch.setattr(telemetry, "TracerProvider", FakeProvider)
    monkeypatch.setattr(
        telemetry.trace,
        "set_tracer_provider",
        lambda provider: calls.update(trace_provider=provider),
    )
    monkeypatch.setattr(
        telemetry.atexit,
        "register",
        lambda callback: calls.update(shutdown=callback),
    )
    monkeypatch.setenv(
        "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
        "http://tempo:4318/v1/traces",
    )
    monkeypatch.setenv("OTEL_DEPLOYMENT_ENVIRONMENT", "test")

    assert telemetry.configure_tracing("engine-test") is True

    provider = telemetry._provider
    assert isinstance(provider, FakeProvider)
    assert calls["resource"] == {
        "service.name": "engine-test",
        "deployment.environment.name": "test",
    }
    assert calls["exporter"] == {
        "endpoint": "http://tempo:4318/v1/traces",
        "timeout": 5,
    }
    assert calls["processor"]["max_queue_size"] == 2048
    assert calls["processor"]["schedule_delay_millis"] == 5000
    assert calls["processor"]["export_timeout_millis"] == 5000
    assert calls["trace_provider"] is provider
    assert calls["shutdown"] == provider.shutdown


def test_extracted_context_forwards_metadata_as_a_mapping(monkeypatch):
    calls = {}
    monkeypatch.setattr(
        telemetry.propagate,
        "extract",
        lambda carrier: calls.setdefault("carrier", carrier),
    )

    result = telemetry.extracted_context([
        ("traceparent", "00-test"),
        ("tracestate", "vendor=value"),
    ])

    assert result == {
        "traceparent": "00-test",
        "tracestate": "vendor=value",
    }
    assert calls["carrier"] == result
