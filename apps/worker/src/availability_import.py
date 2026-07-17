"""Resource-bounded parser orchestration for durable availability imports."""

from __future__ import annotations

import base64
import asyncio
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile
from typing import Any
import uuid
from cryptography.exceptions import InvalidTag
from cryptography.hazmat.primitives.ciphers.aead import AESGCM


from src.availability_import_store import (
    AvailabilityImportBusy,
    AvailabilityImportRejected,
    AvailabilityImportRetryable,
    ClaimedImport,
    cleanup_source,
    claim_import,
    complete_import,
    mark_retrying,
    run_availability_import_retention_loop,
    terminalize_import,
    validate_import_payload,
)


MAX_RESULT_BYTES = 64 * 1024
MAX_ROWS = 21

PDF_SIGNATURE = b"%PDF-"
ENCRYPTED_SOURCE_MAGIC = b"LLAI"
ENCRYPTED_SOURCE_VERSIONS = {1, 2, 3}
AAD_BOUND_ENVELOPE_VERSION = 3
GCM_NONCE_BYTES = 12
GCM_TAG_BYTES = 16
ENCRYPTED_SOURCE_OVERHEAD = len(ENCRYPTED_SOURCE_MAGIC) + 1 + GCM_NONCE_BYTES + GCM_TAG_BYTES


class AvailabilityImportSourceUnavailable(RuntimeError):
    pass


async def process_availability_import(raw: Any, retry_count: int) -> dict[str, Any]:
    payload = validate_import_payload(raw)
    token = uuid.uuid4().hex
    try:
        claimed = await asyncio.to_thread(claim_import, payload, retry_count, token)
    except AvailabilityImportBusy:
        raise
    except AvailabilityImportRejected as exc:
        try:
            path = await asyncio.to_thread(
                terminalize_import,
                payload,
                None,
                "FAILED",
                "CLAIM_REJECTED",
            )
            if path is not None:
                await asyncio.to_thread(cleanup_source, payload, path)
        except Exception as terminal_error:
            raise AvailabilityImportRetryable(
                "failed to terminalize rejected availability import",
                payload,
            ) from terminal_error
        raise exc
    except Exception as exc:
        raise AvailabilityImportRetryable(
            "failed to claim availability import",
            payload,
            token,
        ) from exc

    if claimed.status == "terminal":
        return {"skipped": True, "status": "terminal"}

    try:
        result = await asyncio.to_thread(_parse_claimed_source, claimed)
        source_identity_hash, availability = _validate_result(result)
    except AvailabilityImportRejected:
        path = await asyncio.to_thread(
            terminalize_import,
            payload,
            token,
            "FAILED",
            "INVALID_DOCUMENT",
        )
        await asyncio.to_thread(cleanup_source, payload, path or claimed.path)
        raise
    except Exception as exc:
        raise AvailabilityImportRetryable(
            "availability parser infrastructure failed",
            payload,
            token,
        ) from exc

    try:
        await asyncio.to_thread(
            complete_import,
            payload,
            token,
            source_identity_hash,
            availability,
        )
    except AvailabilityImportRejected:
        path = await asyncio.to_thread(
            terminalize_import,
            payload,
            token,
            "FAILED",
            "FINAL_VALIDATION_FAILED",
        )
        await asyncio.to_thread(cleanup_source, payload, path or claimed.path)
        raise
    except Exception as exc:
        raise AvailabilityImportRetryable(
            "failed to persist availability import",
            payload,
            token,
        ) from exc

    await asyncio.to_thread(cleanup_source, payload, claimed.path)
    return {"parsed": True, "import_id": payload.import_id, "rows": len(availability)}


async def mark_import_retry(
    raw: Any,
    status: str,
    retry_count: int,
    reason: Exception,
) -> None:
    payload = validate_import_payload(raw)
    token = reason.execution_token if isinstance(reason, AvailabilityImportRetryable) else None
    if status == "DEAD_LETTERED":
        path = await asyncio.to_thread(
            terminalize_import,
            payload,
            token,
            status,
            "PROCESSING_FAILED",
        )
        if path is not None:
            await asyncio.to_thread(cleanup_source, payload, path)
        return
    await asyncio.to_thread(mark_retrying, payload, token, retry_count)


def validate_availability_import_config() -> None:
    environment = os.getenv("ENVIRONMENT", os.getenv("NODE_ENV", "development")).lower()
    configured = os.getenv("AVAILABILITY_IMPORT_ENCRYPTION_KEY", "").strip()
    if environment != "production" and not configured:
        return
    key = _decode_availability_import_key(configured)
    password_reset_key = os.getenv("PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY", "").strip()
    if password_reset_key and key == _decode_availability_import_key(password_reset_key):
        raise RuntimeError("AVAILABILITY_IMPORT_ENCRYPTION_KEY must not reuse another payload encryption key")


def _decode_availability_import_key(configured: str | None = None) -> bytes:
    value = configured.strip() if configured is not None else os.getenv(
        "AVAILABILITY_IMPORT_ENCRYPTION_KEY",
        "",
    ).strip()
    try:
        if re.fullmatch(r"[a-fA-F0-9]{64}", value):
            decoded = bytes.fromhex(value)
        else:
            normalized = value.replace("-", "+").replace("_", "/")
            padded = normalized + "=" * ((4 - len(normalized) % 4) % 4)
            decoded = base64.b64decode(padded, validate=True)
            if base64.b64encode(decoded).decode("ascii").rstrip("=") != normalized.rstrip("="):
                raise ValueError("non-canonical key")
    except (ValueError, TypeError) as exc:
        raise RuntimeError("AVAILABILITY_IMPORT_ENCRYPTION_KEY must decode to exactly 32 bytes") from exc
    if len(decoded) != 32:
        raise RuntimeError("AVAILABILITY_IMPORT_ENCRYPTION_KEY must decode to exactly 32 bytes")
    return decoded


def _legacy_source_aad(claimed: ClaimedImport) -> bytes:
    return json.dumps(
        {
            "fileSha256": claimed.file_sha256,
            "importId": claimed.payload.import_id,
            "tenantId": claimed.payload.tenant_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _source_aad(
    claimed: ClaimedImport,
    envelope_version: int = AAD_BOUND_ENVELOPE_VERSION,
) -> bytes:
    return json.dumps(
        {
            "envelopeVersion": envelope_version,
            "fileSha256": claimed.file_sha256,
            "importId": claimed.payload.import_id,
            "requestHash": claimed.request_identity_hash,
            "targetIdentityHash": claimed.target_identity_hash,
            "tenantId": claimed.payload.tenant_id,
        },
        separators=(",", ":"),
        sort_keys=True,
    ).encode("utf-8")


def _decrypt_source_envelope(envelope: bytes | None, claimed: ClaimedImport) -> bytes:
    minimum_size = ENCRYPTED_SOURCE_OVERHEAD + 1
    if envelope is None or len(envelope) < minimum_size:
        raise AvailabilityImportSourceUnavailable("availability import recovery source is unavailable")
    envelope_version = envelope[len(ENCRYPTED_SOURCE_MAGIC)]
    if envelope[:4] != ENCRYPTED_SOURCE_MAGIC or envelope_version not in ENCRYPTED_SOURCE_VERSIONS:
        raise AvailabilityImportSourceUnavailable("availability import recovery envelope is invalid")
    if envelope_version >= AAD_BOUND_ENVELOPE_VERSION and (
        not re.fullmatch(r"[a-f0-9]{64}", claimed.request_identity_hash)
        or not re.fullmatch(r"[a-f0-9]{64}", claimed.target_identity_hash)
    ):
        raise AvailabilityImportSourceUnavailable("availability import recovery binding is invalid")
    nonce_start = 5
    tag_start = nonce_start + GCM_NONCE_BYTES
    ciphertext_start = tag_start + GCM_TAG_BYTES
    nonce = envelope[nonce_start:tag_start]
    tag = envelope[tag_start:ciphertext_start]
    ciphertext = envelope[ciphertext_start:]
    try:
        return AESGCM(_decode_availability_import_key()).decrypt(
            nonce,
            ciphertext + tag,
            _source_aad(claimed, envelope_version)
            if envelope_version >= AAD_BOUND_ENVELOPE_VERSION
            else _legacy_source_aad(claimed),
        )
    except (InvalidTag, ValueError, RuntimeError) as exc:
        raise AvailabilityImportSourceUnavailable("availability import recovery envelope authentication failed") from exc


def _verify_pdf_bytes(source: bytes, claimed: ClaimedImport) -> bytes:
    if (
        len(source) != claimed.file_size
        or len(source) > 5 * 1024 * 1024
        or not source.startswith(PDF_SIGNATURE)
        or hashlib.sha256(source).hexdigest() != claimed.file_sha256
    ):
        raise AvailabilityImportSourceUnavailable("availability import recovery source failed integrity checks")
    return source


def _verify_source_file(claimed: ClaimedImport) -> bytes:
    path = claimed.path
    try:
        if path is None or path.is_symlink() or not path.is_file():
            raise AvailabilityImportSourceUnavailable("availability import local source is unavailable")
        metadata = path.stat()
        if metadata.st_nlink != 1 or metadata.st_size != claimed.file_size + ENCRYPTED_SOURCE_OVERHEAD:
            raise AvailabilityImportSourceUnavailable("availability import local source metadata changed")
        return _verify_pdf_bytes(_decrypt_source_envelope(path.read_bytes(), claimed), claimed)
    except OSError as exc:
        raise AvailabilityImportSourceUnavailable("availability import local source is unavailable") from exc


def _recover_source_bytes(claimed: ClaimedImport) -> bytes:
    if claimed.encrypted_source_payload is not None:
        return _verify_pdf_bytes(
            _decrypt_source_envelope(claimed.encrypted_source_payload, claimed),
            claimed,
        )
    return _verify_source_file(claimed)


def _parse_claimed_source(claimed: ClaimedImport) -> dict[str, Any]:
    source = _recover_source_bytes(claimed)
    with tempfile.TemporaryDirectory(prefix="availability-import-") as directory:
        path = Path(directory) / "source.pdf"
        path.write_bytes(source)
        path.chmod(0o600)
        return _run_parser_subprocess(path)


def _run_parser_subprocess(path: Path) -> dict[str, Any]:
    timeout = _bounded_float("WORKER_PDF_PARSE_TIMEOUT_SECONDS", 15.0, 1.0, 30.0)
    env = {
        "HOME": os.getenv("HOME", "/home/lunchlineup"),
        "PATH": os.getenv("PATH", ""),
        "PYTHONHASHSEED": "random",
        "PYTHONPATH": str(Path(__file__).resolve().parents[1]),
        "WORKER_MAX_AVAILABILITY_PDF_BYTES": os.getenv(
            "WORKER_MAX_AVAILABILITY_PDF_BYTES",
            str(5 * 1024 * 1024),
        ),
        "WORKER_MAX_AVAILABILITY_PDF_PAGES": os.getenv(
            "WORKER_MAX_AVAILABILITY_PDF_PAGES",
            "20",
        ),
        "WORKER_MAX_AVAILABILITY_TEXT_CHARS": os.getenv(
            "WORKER_MAX_AVAILABILITY_TEXT_CHARS",
            "100000",
        ),
        "WORKER_MAX_AVAILABILITY_ROWS": os.getenv(
            "WORKER_MAX_AVAILABILITY_ROWS",
            str(MAX_ROWS),
        ),
        "WORKER_PDF_PARSE_MEMORY_BYTES": os.getenv(
            "WORKER_PDF_PARSE_MEMORY_BYTES",
            str(256 * 1024 * 1024),
        ),
        "WORKER_PDF_PARSE_CPU_SECONDS": os.getenv(
            "WORKER_PDF_PARSE_CPU_SECONDS",
            "10",
        ),
    }
    with tempfile.TemporaryFile() as output:
        process = subprocess.Popen(
            [sys.executable, "-m", "src.parser.pdf_sandbox", str(path)],
            stdin=subprocess.DEVNULL,
            stdout=output,
            stderr=subprocess.DEVNULL,
            env=env,
            close_fds=True,
        )
        try:
            return_code = process.wait(timeout=timeout)
        except subprocess.TimeoutExpired as exc:
            process.kill()
            process.wait()
            raise AvailabilityImportRejected("availability PDF parsing timed out") from exc
        if return_code == 2:
            raise AvailabilityImportRejected("availability PDF was rejected")
        if return_code != 0:
            raise RuntimeError("availability PDF parser subprocess failed")
        output.seek(0, os.SEEK_END)
        size = output.tell()
        if size <= 0 or size > MAX_RESULT_BYTES:
            raise AvailabilityImportRejected("availability PDF parser result is invalid")
        output.seek(0)
        try:
            return json.loads(output.read(MAX_RESULT_BYTES).decode("ascii"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise AvailabilityImportRejected("availability PDF parser result is invalid") from exc


def _validate_result(result: Any) -> tuple[str, list[dict[str, int | None]]]:
    source_identity_hash = result.get("sourceStaffIdentityHash") if isinstance(result, dict) else None
    if not isinstance(source_identity_hash, str) or not re.fullmatch(r"[a-f0-9]{64}", source_identity_hash):
        raise AvailabilityImportRejected("availability PDF parser result is invalid")
    rows = result.get("parsedAvailability") if isinstance(result, dict) else None
    if not isinstance(rows, list) or not 1 <= len(rows) <= MAX_ROWS:
        raise AvailabilityImportRejected("availability PDF parser result is invalid")
    normalized: list[dict[str, int | None]] = []
    seen: set[tuple[int, int, int]] = set()
    for row in rows:
        if not isinstance(row, dict) or set(row) != {
            "dayOfWeek",
            "startTimeMinutes",
            "endTimeMinutes",
        }:
            raise AvailabilityImportRejected("availability PDF parser result is invalid")
        day = row["dayOfWeek"]
        start = row["startTimeMinutes"]
        end = row["endTimeMinutes"]
        if any(
            isinstance(value, bool) or not isinstance(value, int)
            for value in (day, start, end)
        ):
            raise AvailabilityImportRejected("availability PDF parser result is invalid")
        if (
            not 0 <= day <= 6
            or not 0 <= start <= 1439
            or not 0 <= end <= 1439
            or start == end
        ):
            raise AvailabilityImportRejected("availability PDF parser result is invalid")
        key = (day, start, end)
        if key in seen:
            raise AvailabilityImportRejected("availability PDF parser result is invalid")
        seen.add(key)
        normalized.append(
            {
                "locationId": None,
                "dayOfWeek": day,
                "startTimeMinutes": start,
                "endTimeMinutes": end,
            }
        )
    normalized.sort(
        key=lambda row: (
            int(row["dayOfWeek"]),
            int(row["startTimeMinutes"]),
            int(row["endTimeMinutes"]),
        )
    )
    return source_identity_hash, normalized


def _bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    try:
        value = float(os.getenv(name, str(default)))
    except ValueError:
        value = default
    return max(minimum, min(maximum, value))
