import hashlib
import os
from pathlib import Path
import sys
import tempfile
from types import SimpleNamespace
import unittest
from unittest.mock import MagicMock, patch

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

from src.parser import pdf_sandbox, pdf_service
from src.parser.pdf_parser import (  # noqa: E402
    MAX_AVAILABILITY_PDF_BYTES,
    MAX_AVAILABILITY_PDF_PAGES,
    MAX_AVAILABILITY_TEXT_CHARS,
    AvailabilityParseError,
    AvailabilityParser,
)


class FakePage(dict):
    def __init__(self, text="", **values):
        super().__init__(values)
        self.text = text

    def extract_text(self):
        return self.text


def fake_reader(*, pages=None, encrypted=False, catalog=None):
    return SimpleNamespace(
        is_encrypted=encrypted,
        pages=list(pages or []),
        trailer={"/Root": {} if catalog is None else catalog},
    )


class AvailabilityParserTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory()
        self.pdf_path = Path(self.temp_dir.name) / "availability.pdf"
        self.pdf_path.write_bytes(b"%PDF-1.7\n")

    def tearDown(self):
        self.temp_dir.cleanup()

    def pypdf_module(self, reader):
        return SimpleNamespace(PdfReader=lambda *_args, **_kwargs: reader)

    def test_parses_extracted_pdf_text_to_normalized_private_output(self):
        parser = AvailabilityParser()
        with patch.object(
            parser,
            "_extract_text",
            return_value="Employee ID: EMP-10492\nMonday: 09:00 AM - 05:00 PM\nTue: 13:30 - 18:00",
        ):
            result = parser.parse_document("availability.pdf")

        self.assertEqual(result["documentStatus"], "PROCESSED")
        self.assertNotIn("EMP-10492", str(result))
        self.assertEqual(result["parsedAvailability"], [
            {"dayOfWeek": 1, "startTimeMinutes": 540, "endTimeMinutes": 1020},
            {"dayOfWeek": 2, "startTimeMinutes": 810, "endTimeMinutes": 1080},
        ])

    def test_rejects_pdf_text_without_employee_id(self):
        parser = AvailabilityParser()
        with patch.object(parser, "_extract_text", return_value="Monday: 09:00 AM - 05:00 PM"):
            with self.assertRaises(AvailabilityParseError):
                parser.parse_document("availability.pdf")

    def test_hashes_a_visible_email_identifier_case_insensitively_without_returning_it(self):
        parser = AvailabilityParser()
        with patch.object(
            parser,
            "_extract_text",
            return_value="Staff ID: Invitee@Example.com\nMonday: 09:00 - 17:00",
        ):
            result = parser.parse_document("availability.pdf")

        self.assertEqual(
            result["sourceStaffIdentityHash"],
            hashlib.sha256(b"invitee@example.com").hexdigest(),
        )
        self.assertNotIn("Invitee@Example.com", str(result))

    def test_rejects_multiple_distinct_normalized_employee_identities(self):
        parser = AvailabilityParser()
        with patch.object(
            parser,
            "_extract_text",
            return_value=(
                "Employee ID: employee-1\n"
                "Staff ID: EMPLOYEE-2\n"
                "Monday: 09:00 - 17:00"
            ),
        ):
            with self.assertRaisesRegex(AvailabilityParseError, "multiple employee IDs"):
                parser.parse_document("availability.pdf")

    def test_accepts_repeated_employee_identity_after_case_normalization(self):
        parser = AvailabilityParser()
        with patch.object(
            parser,
            "_extract_text",
            return_value=(
                "Employee ID: Employee-1\n"
                "Staff ID: employee-1\n"
                "Monday: 09:00 - 17:00"
            ),
        ):
            result = parser.parse_document("availability.pdf")

        self.assertEqual(
            result["sourceStaffIdentityHash"],
            hashlib.sha256(b"employee-1").hexdigest(),
        )

    def test_rejects_non_pdf_files_before_extraction(self):
        parser = AvailabilityParser()
        with patch.object(parser, "_extract_text") as extract_text:
            with self.assertRaises(AvailabilityParseError):
                parser.parse_document("availability.txt")
        extract_text.assert_not_called()

    def test_rejects_oversized_pdf_before_reader_load(self):
        parser = AvailabilityParser()
        metadata = SimpleNamespace(
            st_size=MAX_AVAILABILITY_PDF_BYTES + 1,
            st_nlink=1,
        )
        with patch.object(Path, "is_symlink", return_value=False), \
                patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "stat", return_value=metadata):
            with self.assertRaisesRegex(AvailabilityParseError, "maximum upload size"):
                parser._extract_text(Path("availability.pdf"))

    def test_rejects_encrypted_pdf(self):
        parser = AvailabilityParser()
        reader = fake_reader(encrypted=True)
        with patch.dict(sys.modules, {"pypdf": self.pypdf_module(reader)}):
            with self.assertRaisesRegex(AvailabilityParseError, "encrypted"):
                parser._extract_text(self.pdf_path)

    def test_rejects_pdf_with_too_many_pages(self):
        parser = AvailabilityParser()
        reader = fake_reader(
            pages=[FakePage() for _ in range(MAX_AVAILABILITY_PDF_PAGES + 1)],
        )
        with patch.dict(sys.modules, {"pypdf": self.pypdf_module(reader)}):
            with self.assertRaisesRegex(AvailabilityParseError, "too many pages"):
                parser._extract_text(self.pdf_path)

    def test_rejects_excessive_extracted_text(self):
        parser = AvailabilityParser()
        reader = fake_reader(pages=[FakePage("A" * (MAX_AVAILABILITY_TEXT_CHARS + 1))])
        with patch.dict(sys.modules, {"pypdf": self.pypdf_module(reader)}):
            with self.assertRaisesRegex(AvailabilityParseError, "text exceeds"):
                parser._extract_text(self.pdf_path)

    def test_rejects_document_and_annotation_active_content(self):
        parser = AvailabilityParser()
        readers = [
            fake_reader(catalog={"/OpenAction": {}}),
            fake_reader(pages=[FakePage(**{"/Annots": [{"/A": {}}]})]),
            fake_reader(catalog={"/Names": {"/EmbeddedFiles": {}}}),
        ]
        for reader in readers:
            with self.subTest(reader=reader), \
                    patch.dict(sys.modules, {"pypdf": self.pypdf_module(reader)}):
                with self.assertRaisesRegex(AvailabilityParseError, "active content"):
                    parser._extract_text(self.pdf_path)

    def test_rejects_duplicate_and_over_limit_rows(self):
        parser = AvailabilityParser()
        duplicate = "Employee ID: E1\nMonday: 09:00 - 17:00\nMonday: 09:00 - 17:00"
        with patch.object(parser, "_extract_text", return_value=duplicate):
            with self.assertRaisesRegex(AvailabilityParseError, "duplicate"):
                parser.parse_document("availability.pdf")

        rows = "\n".join(f"Monday: {hour:02d}:00 - {hour + 1:02d}:00" for hour in range(22))
        with patch.object(parser, "_extract_text", return_value=f"Employee ID: E1\n{rows}"):
            with self.assertRaisesRegex(AvailabilityParseError, "too many rows"):
                parser.parse_document("availability.pdf")

    def test_staff_log_reference_does_not_expose_identifier_suffix(self):
        parser = AvailabilityParser()
        self.assertNotIn("0492", parser._safe_ref("EMP-10492"))

    def test_parser_client_only_transfers_bounded_pdf_bytes(self):
        source = Path(pdf_sandbox.__file__).read_text(encoding="utf-8")
        self.assertNotIn("pdf_parser", source)
        self.assertEqual(pdf_sandbox._read_document(self.pdf_path), b"%PDF-1.7\n")

    def test_parser_service_child_environment_drops_production_secrets(self):
        with patch.dict(
            os.environ,
            {
                "DATABASE_URL": "postgresql://secret",
                "RABBITMQ_URL": "amqp://secret",
                "STRIPE_SECRET_KEY": "sk_live_secret",
                "RESEND_API_KEY": "re_secret",
                "PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY": "secret",
                "WORKER_MAX_AVAILABILITY_PDF_PAGES": "12",
            },
            clear=True,
        ):
            environment = pdf_service._child_environment()

        self.assertEqual(environment["WORKER_MAX_AVAILABILITY_PDF_PAGES"], "12")
        self.assertNotIn("DATABASE_URL", environment)
        self.assertNotIn("RABBITMQ_URL", environment)
        self.assertNotIn("STRIPE_SECRET_KEY", environment)
        self.assertNotIn("RESEND_API_KEY", environment)
        self.assertNotIn("PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY", environment)
        self.assertLessEqual(
            set(environment),
            {
                "HOME",
                "PATH",
                "PYTHONHASHSEED",
                "PYTHONPATH",
                "TMPDIR",
                *pdf_service._LIMIT_ENV_NAMES,
            },
        )

    def test_parser_service_health_does_not_execute_document_parser(self):
        with patch.object(pdf_service, "_execute_parser") as execute:
            self.assertEqual(
                pdf_service._handle_request(pdf_sandbox.OP_HEALTH, b""),
                (pdf_sandbox.STATUS_OK, b""),
            )
        execute.assert_not_called()

    def test_parser_service_rejects_oversized_ipc_payload(self):
        with patch.object(pdf_service, "_maximum_document_bytes", return_value=8), \
                patch.object(pdf_service, "_execute_parser") as execute:
            self.assertEqual(
                pdf_service._handle_request(pdf_sandbox.OP_PARSE, b"%PDF-1234"),
                (pdf_sandbox.STATUS_REJECTED, b""),
            )
        execute.assert_not_called()

    def test_parser_service_recycles_after_parse_client_disconnects(self):
        connection = MagicMock()
        document = b"%PDF-1.7\n"
        header = pdf_sandbox.REQUEST_HEADER.pack(pdf_sandbox.OP_PARSE, len(document))
        with patch.object(pdf_service, "_recv_exact", side_effect=[header, document]), \
                patch.object(
                    pdf_service,
                    "_handle_request",
                    return_value=(pdf_sandbox.STATUS_OK, b"{}"),
                ), \
                patch.object(
                    pdf_service,
                    "_send_response",
                    side_effect=BrokenPipeError,
                ):
            self.assertTrue(pdf_service._serve_connection(connection))

    def test_parser_service_refuses_non_socket_ipc_path(self):
        socket_path = Path(self.temp_dir.name) / "parser.sock"
        socket_path.write_text("not a socket", encoding="utf-8")
        with self.assertRaisesRegex(RuntimeError, "not a socket"):
            pdf_service._prepare_socket_path(socket_path)


if __name__ == "__main__":
    unittest.main()
