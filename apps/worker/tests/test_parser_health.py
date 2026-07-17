import os
from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

from src import parser_health  # noqa: E402


class ParserHealthTests(unittest.IsolatedAsyncioTestCase):
    def test_probe_uses_sanitized_environment(self):
        result = SimpleNamespace(returncode=0)
        with (
            patch.dict(os.environ, {
                "DATABASE_URL": "postgres://operator:secret@database/prod",
                "PARSER_SOCKET_PATH": "/run/lunchlineup-parser/parser.sock",
            }),
            patch.object(parser_health.subprocess, "run", return_value=result) as run,
        ):
            self.assertTrue(parser_health.check_pdf_parser_health())

        command, kwargs = run.call_args
        self.assertEqual(
            command[0],
            [sys.executable, "-m", "src.parser.pdf_sandbox", "--health"],
        )
        self.assertEqual(
            kwargs["timeout"],
            parser_health.PDF_PARSER_HEALTH_TIMEOUT_SECONDS,
        )
        self.assertEqual(
            kwargs["env"]["PARSER_SOCKET_PATH"],
            "/run/lunchlineup-parser/parser.sock",
        )
        self.assertNotIn("DATABASE_URL", kwargs["env"])
        self.assertEqual(kwargs["stdout"], parser_health.subprocess.DEVNULL)
        self.assertEqual(kwargs["stderr"], parser_health.subprocess.DEVNULL)

    def test_probe_fails_closed_on_timeout(self):
        with patch.object(
            parser_health.subprocess,
            "run",
            side_effect=parser_health.subprocess.TimeoutExpired("pdf-health", 3),
        ):
            self.assertFalse(parser_health.check_pdf_parser_health())

    async def test_refresh_updates_readiness_and_failure_metrics(self):
        with (
            patch.object(parser_health, "check_pdf_parser_health", return_value=False),
            patch.object(parser_health.PDF_PARSER_READY, "set") as set_ready,
            patch.object(
                parser_health.PDF_PARSER_HEALTH_FAILURES,
                "inc",
            ) as increment_failures,
        ):
            self.assertFalse(await parser_health.refresh_pdf_parser_health())

        set_ready.assert_called_once_with(0)
        increment_failures.assert_called_once_with()


if __name__ == "__main__":
    unittest.main()
