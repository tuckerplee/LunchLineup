from pathlib import Path
import sys
from types import SimpleNamespace
import unittest
from unittest.mock import patch

WORKER_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(WORKER_ROOT))

from src.parser.pdf_parser import (  # noqa: E402
    MAX_AVAILABILITY_PDF_BYTES,
    MAX_AVAILABILITY_PDF_PAGES,
    MAX_AVAILABILITY_TEXT_CHARS,
    AvailabilityParseError,
    AvailabilityParser,
)


class AvailabilityParserTests(unittest.TestCase):
    def test_parses_extracted_pdf_text_without_mock_defaults(self):
        parser = AvailabilityParser()

        with patch.object(
            parser,
            "_extract_text",
            return_value="Employee ID: EMP-10492\nMonday: 09:00 AM - 05:00 PM\nTue: 13:30 - 18:00",
        ):
            result = parser.parse_document("availability.pdf")

        self.assertEqual(result["staff_id"], "EMP-10492")
        self.assertEqual(result["document_status"], "PROCESSED")
        self.assertEqual(result["parsed_availability"], [
            {
                "day": "Monday",
                "day_of_week": "monday",
                "start_time": "09:00",
                "end_time": "17:00",
            },
            {
                "day": "Tuesday",
                "day_of_week": "tuesday",
                "start_time": "13:30",
                "end_time": "18:00",
            },
        ])

    def test_rejects_pdf_text_without_employee_id(self):
        parser = AvailabilityParser()

        with patch.object(parser, "_extract_text", return_value="Monday: 09:00 AM - 05:00 PM"):
            with self.assertRaises(AvailabilityParseError):
                parser.parse_document("availability.pdf")

    def test_rejects_non_pdf_files_before_extraction(self):
        parser = AvailabilityParser()

        with patch.object(parser, "_extract_text") as extract_text:
            with self.assertRaises(AvailabilityParseError):
                parser.parse_document("availability.txt")

        extract_text.assert_not_called()

    def test_rejects_oversized_pdf_before_reader_load(self):
        parser = AvailabilityParser()

        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "stat", return_value=SimpleNamespace(st_size=MAX_AVAILABILITY_PDF_BYTES + 1)):
            with self.assertRaisesRegex(AvailabilityParseError, "maximum upload size"):
                parser._extract_text(Path("availability.pdf"))

    def test_rejects_encrypted_pdf(self):
        parser = AvailabilityParser()
        fake_reader = SimpleNamespace(is_encrypted=True, pages=[])

        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "stat", return_value=SimpleNamespace(st_size=1024)), \
                patch.dict(sys.modules, {"pypdf": SimpleNamespace(PdfReader=lambda _: fake_reader)}):
            with self.assertRaisesRegex(AvailabilityParseError, "encrypted"):
                parser._extract_text(Path("availability.pdf"))

    def test_rejects_pdf_with_too_many_pages(self):
        parser = AvailabilityParser()
        fake_reader = SimpleNamespace(
            is_encrypted=False,
            pages=[SimpleNamespace(extract_text=lambda: "") for _ in range(MAX_AVAILABILITY_PDF_PAGES + 1)],
        )

        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "stat", return_value=SimpleNamespace(st_size=1024)), \
                patch.dict(sys.modules, {"pypdf": SimpleNamespace(PdfReader=lambda _: fake_reader)}):
            with self.assertRaisesRegex(AvailabilityParseError, "too many pages"):
                parser._extract_text(Path("availability.pdf"))

    def test_rejects_excessive_extracted_text(self):
        parser = AvailabilityParser()
        page_text = "A" * (MAX_AVAILABILITY_TEXT_CHARS + 1)
        fake_reader = SimpleNamespace(
            is_encrypted=False,
            pages=[SimpleNamespace(extract_text=lambda: page_text)],
        )

        with patch.object(Path, "is_file", return_value=True), \
                patch.object(Path, "stat", return_value=SimpleNamespace(st_size=1024)), \
                patch.dict(sys.modules, {"pypdf": SimpleNamespace(PdfReader=lambda _: fake_reader)}):
            with self.assertRaisesRegex(AvailabilityParseError, "text exceeds"):
                parser._extract_text(Path("availability.pdf"))

    def test_staff_log_reference_does_not_expose_identifier_suffix(self):
        parser = AvailabilityParser()

        self.assertNotIn("0492", parser._safe_ref("EMP-10492"))


if __name__ == "__main__":
    unittest.main()
