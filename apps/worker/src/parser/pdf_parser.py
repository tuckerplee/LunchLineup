from datetime import datetime
import hashlib
import logging
import os
from pathlib import Path
import re
from typing import Any, Dict, List

logger = logging.getLogger("worker.parser")


def _int_env(name: str, default: int, minimum: int, maximum: int) -> int:
    try:
        value = int(os.getenv(name, str(default)))
    except ValueError:
        return default
    return max(minimum, min(maximum, value))


MAX_AVAILABILITY_PDF_BYTES = _int_env("WORKER_MAX_AVAILABILITY_PDF_BYTES", 5 * 1024 * 1024, 1024, 25 * 1024 * 1024)
MAX_AVAILABILITY_PDF_PAGES = _int_env("WORKER_MAX_AVAILABILITY_PDF_PAGES", 20, 1, 100)
MAX_AVAILABILITY_TEXT_CHARS = _int_env("WORKER_MAX_AVAILABILITY_TEXT_CHARS", 100_000, 1_000, 1_000_000)


class AvailabilityParseError(ValueError):
    """Raised when an uploaded availability document cannot be parsed safely."""


class AvailabilityParser:
    """
    Parser for extracting employee availability and constraints from uploaded PDF forms.
    """

    def __init__(self):
        self.staff_id_pattern = re.compile(r"\b(?:Employee|Staff)\s*ID:\s*([A-Z0-9._:@+-]+)", re.IGNORECASE)
        time_token = r"(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)"
        self.availability_pattern = re.compile(
            rf"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b"
            rf"\s*:\s*{time_token}\s*(?:-|to)\s*{time_token}\b",
            re.IGNORECASE,
        )

    def parse_document(self, file_path: str) -> Dict[str, Any]:
        """
        Extract structured scheduling data from a physical PDF document.
        Fails closed when required text cannot be extracted.
        """
        path = Path(file_path)
        logger.info("Initiating PDF extraction pipeline for %s", path.name)

        if path.suffix.lower() != ".pdf":
            raise AvailabilityParseError("availability import only supports PDF files")

        extracted_text = self._extract_text(path)
        if not extracted_text.strip():
            raise AvailabilityParseError("no readable text found in availability PDF")

        staff_match = self.staff_id_pattern.search(extracted_text)
        if not staff_match:
            raise AvailabilityParseError("employee ID not found in availability PDF")
        staff_id = staff_match.group(1).strip()

        availability: List[Dict[str, str]] = []
        for match in self.availability_pattern.finditer(extracted_text):
            day, start, end = match.groups()
            day_of_week = self._normalize_day(day)
            availability.append({
                "day": day_of_week,
                "day_of_week": day_of_week.lower(),
                "start_time": self._normalize_time(start),
                "end_time": self._normalize_time(end),
            })

        if not availability:
            raise AvailabilityParseError("no availability rows found in availability PDF")

        logger.info("Successfully parsed availability for staff_ref=%s rules=%s", self._safe_ref(staff_id), len(availability))

        return {
            "staff_id": staff_id,
            "parsed_availability": availability,
            "document_status": "PROCESSED",
        }

    def _extract_text(self, file_path: Path) -> str:
        if not file_path.is_file():
            raise AvailabilityParseError("availability PDF was not found")
        if file_path.stat().st_size > MAX_AVAILABILITY_PDF_BYTES:
            raise AvailabilityParseError("availability PDF exceeds the maximum upload size")

        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise AvailabilityParseError("pypdf is required for availability PDF imports") from exc

        try:
            reader = PdfReader(str(file_path))
            if getattr(reader, "is_encrypted", False):
                raise AvailabilityParseError("encrypted availability PDFs are not supported")
            if len(reader.pages) > MAX_AVAILABILITY_PDF_PAGES:
                raise AvailabilityParseError("availability PDF has too many pages")

            extracted: List[str] = []
            total_chars = 0
            for page in reader.pages:
                page_text = page.extract_text() or ""
                total_chars += len(page_text)
                if total_chars > MAX_AVAILABILITY_TEXT_CHARS:
                    raise AvailabilityParseError("availability PDF text exceeds the maximum size")
                extracted.append(page_text)

            return "\n".join(extracted)
        except AvailabilityParseError:
            raise
        except Exception as exc:
            raise AvailabilityParseError("unable to extract text from availability PDF") from exc

    def _normalize_day(self, value: str) -> str:
        key = value.strip().lower()[:3]
        days = {
            "mon": "Monday",
            "tue": "Tuesday",
            "wed": "Wednesday",
            "thu": "Thursday",
            "fri": "Friday",
            "sat": "Saturday",
            "sun": "Sunday",
        }
        if key not in days:
            raise AvailabilityParseError("availability row contains an invalid day")
        return days[key]

    def _normalize_time(self, value: str) -> str:
        normalized = re.sub(r"\s+", " ", value.strip().upper().replace(".", ""))
        normalized = re.sub(r"(?<=\d)(AM|PM)$", r" \1", normalized)
        for fmt in ("%I:%M %p", "%I %p", "%H:%M", "%H"):
            try:
                return datetime.strptime(normalized, fmt).strftime("%H:%M")
            except ValueError:
                continue
        raise AvailabilityParseError("availability row contains an invalid time")

    def _safe_ref(self, value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]
