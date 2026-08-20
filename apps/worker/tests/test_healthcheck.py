import pytest

from src.healthcheck import check, main


BASE = """
lunchlineup_pdf_parser_ready 1.0
lunchlineup_password_reset_email_sweep_running 1
lunchlineup_password_reset_email_sweep_ready 1
lunchlineup_password_reset_email_systemic_provider_failure 0
lunchlineup_password_reset_email_sweep_last_success_unixtime 95
lunchlineup_staff_invitation_sweep_running 1
lunchlineup_staff_invitation_sweep_ready 1
lunchlineup_staff_invitation_systemic_provider_failure 0
lunchlineup_staff_invitation_sweep_last_success_unixtime 9.5e1
"""


def test_healthcheck_requires_parser_readiness(monkeypatch):
    monkeypatch.delenv("PASSWORD_RESET_EMAIL_OUTBOX_ENABLED", raising=False)
    monkeypatch.delenv("STAFF_INVITATION_OUTBOX_ENABLED", raising=False)
    check("lunchlineup_pdf_parser_ready 1")
    with pytest.raises(RuntimeError, match="pdf_parser_ready"):
        check("lunchlineup_pdf_parser_ready 0")


def test_healthcheck_enforces_enabled_email_sweeps(monkeypatch):
    monkeypatch.setenv("PASSWORD_RESET_EMAIL_OUTBOX_ENABLED", "true")
    monkeypatch.setenv("STAFF_INVITATION_OUTBOX_ENABLED", "true")
    monkeypatch.setenv("PASSWORD_RESET_EMAIL_SWEEP_MAX_STALENESS_SECONDS", "10")
    monkeypatch.setenv("STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS", "10")
    check(BASE, now=100)


def test_healthcheck_rejects_stale_or_failed_provider_state(monkeypatch):
    monkeypatch.setenv("PASSWORD_RESET_EMAIL_OUTBOX_ENABLED", "true")
    monkeypatch.setenv("PASSWORD_RESET_EMAIL_SWEEP_MAX_STALENESS_SECONDS", "4")
    with pytest.raises(RuntimeError, match="stale"):
        check(BASE, now=100)
    with pytest.raises(RuntimeError, match="systemic_provider_failure"):
        check(BASE.replace("systemic_provider_failure 0", "systemic_provider_failure 1", 1), now=96)


def test_main_fetches_metrics_only_from_fixed_loopback(monkeypatch):
    calls = []

    class Response:
        status = 200

        @staticmethod
        def read(limit):
            assert limit == 2_000_001
            return b"lunchlineup_pdf_parser_ready 1\n"

    class Connection:
        def __init__(self, host, port, timeout):
            calls.append(("connect", host, port, timeout))

        def request(self, method, path, headers):
            calls.append(("request", method, path, headers))

        @staticmethod
        def getresponse():
            return Response()

        def close(self):
            calls.append(("close",))

    monkeypatch.setenv("WORKER_METRICS_PORT", "3011")
    monkeypatch.delenv("PASSWORD_RESET_EMAIL_OUTBOX_ENABLED", raising=False)
    monkeypatch.delenv("STAFF_INVITATION_OUTBOX_ENABLED", raising=False)
    monkeypatch.setattr("src.healthcheck.http.client.HTTPConnection", Connection)

    main()

    assert calls == [
        ("connect", "127.0.0.1", 3011, 3),
        ("request", "GET", "/metrics", {"Host": "127.0.0.1"}),
        ("close",),
    ]
