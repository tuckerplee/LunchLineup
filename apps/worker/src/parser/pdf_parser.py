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
MAX_AVAILABILITY_ROWS = _int_env("WORKER_MAX_AVAILABILITY_ROWS", 21, 1, 100)
PDF_SIGNATURE = b"%PDF-"
STAFF_IDENTITY_PATTERN = re.compile(r"^[A-Za-z0-9._:@+-]{1,128}$")


class AvailabilityParseError(ValueError):
    """Raised when an uploaded availability document cannot be parsed safely."""


class AvailabilityParser:
    """Extract bounded availability rows from an untrusted PDF."""

    def __init__(self):
        self.staff_id_pattern = re.compile(r"\b(?:Employee|Staff)\s*ID:\s*(\S+)", re.IGNORECASE)
        time_token = r"(\d{1,2}(?::\d{2})?\s*(?:AM|PM)?)"
        self.availability_pattern = re.compile(
            rf"\b(Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday|Mon|Tue|Wed|Thu|Fri|Sat|Sun)\b"
            rf"\s*:\s*{time_token}\s*(?:-|to)\s*{time_token}\b",
            re.IGNORECASE,
        )

    def parse_document(self, file_path: str) -> Dict[str, Any]:
        path = Path(file_path)
        logger.info("Initiating PDF extraction pipeline document_ref=%s", self._safe_ref(path.name))

        if path.suffix.lower() != ".pdf":
            raise AvailabilityParseError("availability import only supports PDF files")

        extracted_text = self._extract_text(path)
        if not extracted_text.strip():
            raise AvailabilityParseError("no readable text found in availability PDF")

        staff_identity_hashes = {
            self._identity_hash(match.group(1))
            for match in self.staff_id_pattern.finditer(extracted_text)
        }
        if not staff_identity_hashes:
            raise AvailabilityParseError("employee ID not found in availability PDF")
        if len(staff_identity_hashes) != 1:
            raise AvailabilityParseError("availability PDF contains multiple employee IDs")
        staff_identity_hash = next(iter(staff_identity_hashes))

        availability: List[Dict[str, int]] = []
        for match in self.availability_pattern.finditer(extracted_text):
            if len(availability) >= MAX_AVAILABILITY_ROWS:
                raise AvailabilityParseError("availability PDF has too many rows")
            day, start, end = match.groups()
            availability.append({
                "dayOfWeek": self._day_index(day),
                "startTimeMinutes": self._time_minutes(start),
                "endTimeMinutes": self._time_minutes(end),
            })

        if not availability:
            raise AvailabilityParseError("no availability rows found in availability PDF")

        unique_rows = {
            (row["dayOfWeek"], row["startTimeMinutes"], row["endTimeMinutes"])
            for row in availability
        }
        if len(unique_rows) != len(availability):
            raise AvailabilityParseError("availability PDF contains duplicate rows")

        availability.sort(key=lambda row: (row["dayOfWeek"], row["startTimeMinutes"], row["endTimeMinutes"]))
        logger.info(
            "Successfully parsed availability document staff_ref=%s rules=%s",
            staff_identity_hash[:12],
            len(availability),
        )
        return {
            "sourceStaffIdentityHash": staff_identity_hash,
            "parsedAvailability": availability,
            "documentStatus": "PROCESSED",
        }

    def _extract_text(self, file_path: Path) -> str:
        if file_path.is_symlink() or not file_path.is_file():
            raise AvailabilityParseError("availability PDF was not found")
        metadata = file_path.stat()
        if metadata.st_nlink != 1:
            raise AvailabilityParseError("availability PDF has an invalid storage link")
        if metadata.st_size <= len(PDF_SIGNATURE) or metadata.st_size > MAX_AVAILABILITY_PDF_BYTES:
            raise AvailabilityParseError("availability PDF exceeds the maximum upload size")
        with file_path.open("rb") as source:
            if source.read(len(PDF_SIGNATURE)) != PDF_SIGNATURE:
                raise AvailabilityParseError("availability PDF has an invalid signature")

        try:
            from pypdf import PdfReader
        except ImportError as exc:
            raise AvailabilityParseError("pypdf is required for availability PDF imports") from exc

        try:
            reader = PdfReader(str(file_path), strict=True)
            if getattr(reader, "is_encrypted", False):
                raise AvailabilityParseError("encrypted availability PDFs are not supported")
            if len(reader.pages) > MAX_AVAILABILITY_PDF_PAGES:
                raise AvailabilityParseError("availability PDF has too many pages")
            self._reject_active_content(reader)

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

    def _reject_active_content(self, reader: Any) -> None:
        root = reader.trailer.get("/Root")
        if root is None:
            raise AvailabilityParseError("availability PDF has no document catalog")
        catalog = root.get_object() if hasattr(root, "get_object") else root
        if any(key in catalog for key in ("/OpenAction", "/AA")):
            raise AvailabilityParseError("availability PDF contains active content")
        names = catalog.get("/Names")
        if names is not None:
            names = names.get_object() if hasattr(names, "get_object") else names
            if any(key in names for key in ("/JavaScript", "/EmbeddedFiles")):
                raise AvailabilityParseError("availability PDF contains active content")
        for page in reader.pages:
            if "/AA" in page:
                raise AvailabilityParseError("availability PDF contains active content")
            annotations = page.get("/Annots") or []
            for annotation in annotations:
                item = annotation.get_object() if hasattr(annotation, "get_object") else annotation
                if any(key in item for key in ("/A", "/AA", "/JS", "/RichMediaContent")):
                    raise AvailabilityParseError("availability PDF contains active content")

    def _day_index(self, value: str) -> int:
        key = value.strip().lower()[:3]
        days = {"sun": 0, "mon": 1, "tue": 2, "wed": 3, "thu": 4, "fri": 5, "sat": 6}
        if key not in days:
            raise AvailabilityParseError("availability row contains an invalid day")
        return days[key]

    def _time_minutes(self, value: str) -> int:
        normalized = re.sub(r"\s+", " ", value.strip().upper().replace(".", ""))
        normalized = re.sub(r"(?<=\d)(AM|PM)$", r" \1", normalized)
        for fmt in ("%I:%M %p", "%I %p", "%H:%M", "%H"):
            try:
                parsed = datetime.strptime(normalized, fmt)
                return parsed.hour * 60 + parsed.minute
            except ValueError:
                continue
        raise AvailabilityParseError("availability row contains an invalid time")

    def _safe_ref(self, value: str) -> str:
        return hashlib.sha256(value.encode("utf-8")).hexdigest()[:12]

    def _identity_hash(self, value: str) -> str:
        normalized = value.strip()
        if not STAFF_IDENTITY_PATTERN.fullmatch(normalized):
            raise AvailabilityParseError("employee ID in availability PDF is invalid")
        return hashlib.sha256(normalized.lower().encode("utf-8")).hexdigest()
