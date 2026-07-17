"""Bounded client for the isolated availability PDF parser service."""

from __future__ import annotations

import json
import os
from pathlib import Path
import socket
import stat
import struct
import sys


OP_HEALTH = b"H"
OP_PARSE = b"P"
STATUS_OK = 0
STATUS_REJECTED = 2
STATUS_INFRASTRUCTURE_ERROR = 3
REQUEST_HEADER = struct.Struct("!cI")
RESPONSE_HEADER = struct.Struct("!BI")
MAX_RESULT_BYTES = 64 * 1024
DEFAULT_SOCKET_PATH = "/run/lunchlineup-parser/parser.sock"


class ParserClientRejected(ValueError):
    """Raised when a source document is unsafe to send to the parser service."""


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


def _maximum_document_bytes() -> int:
    return _bounded_int(
        "WORKER_MAX_AVAILABILITY_PDF_BYTES",
        5 * 1024 * 1024,
        1024,
        25 * 1024 * 1024,
    )


def _read_document(path: Path) -> bytes:
    if path.suffix.lower() != ".pdf":
        raise ParserClientRejected("availability import only supports PDF files")
    flags = os.O_RDONLY | getattr(os, "O_BINARY", 0) | getattr(os, "O_NOFOLLOW", 0)
    try:
        descriptor = os.open(path, flags)
    except OSError as exc:
        raise ParserClientRejected("availability PDF was not found") from exc
    try:
        metadata = os.fstat(descriptor)
        maximum = _maximum_document_bytes()
        if not stat.S_ISREG(metadata.st_mode) or metadata.st_nlink != 1:
            raise ParserClientRejected("availability PDF has an invalid storage link")
        if metadata.st_size <= 5 or metadata.st_size > maximum:
            raise ParserClientRejected("availability PDF exceeds the maximum upload size")
        with os.fdopen(descriptor, "rb", closefd=False) as source:
            payload = source.read(maximum + 1)
        if len(payload) != metadata.st_size or len(payload) > maximum:
            raise ParserClientRejected("availability PDF source changed during transfer")
        if not payload.startswith(b"%PDF-"):
            raise ParserClientRejected("availability PDF has an invalid signature")
        return payload
    finally:
        os.close(descriptor)


def _recv_exact(connection: socket.socket, size: int) -> bytes:
    chunks: list[bytes] = []
    remaining = size
    while remaining:
        chunk = connection.recv(remaining)
        if not chunk:
            raise ConnectionError("parser service closed the connection")
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def _exchange(operation: bytes, payload: bytes, timeout: float) -> tuple[int, bytes]:
    socket_path = os.getenv("PARSER_SOCKET_PATH", DEFAULT_SOCKET_PATH)
    if not socket_path or "\x00" in socket_path:
        raise ConnectionError("parser service socket is invalid")
    with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as connection:
        connection.settimeout(timeout)
        connection.connect(socket_path)
        connection.sendall(REQUEST_HEADER.pack(operation, len(payload)))
        if payload:
            connection.sendall(payload)
        status, length = RESPONSE_HEADER.unpack(_recv_exact(connection, RESPONSE_HEADER.size))
        if length > MAX_RESULT_BYTES:
            raise ConnectionError("parser service response is too large")
        return status, _recv_exact(connection, length) if length else b""


def _validated_result(payload: bytes) -> bytes:
    if not payload or len(payload) > MAX_RESULT_BYTES:
        raise ConnectionError("parser service response is invalid")
    try:
        parsed = json.loads(payload.decode("ascii"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ConnectionError("parser service response is invalid") from exc
    if not isinstance(parsed, dict):
        raise ConnectionError("parser service response is invalid")
    return payload


def main() -> int:
    if sys.argv[1:] == ["--health"]:
        try:
            status, payload = _exchange(OP_HEALTH, b"", 2.0)
        except (OSError, ConnectionError, TimeoutError):
            return STATUS_INFRASTRUCTURE_ERROR
        return STATUS_OK if status == STATUS_OK and not payload else STATUS_INFRASTRUCTURE_ERROR
    if len(sys.argv) != 2:
        return STATUS_INFRASTRUCTURE_ERROR
    try:
        document = _read_document(Path(sys.argv[1]))
        timeout = _bounded_float("WORKER_PDF_PARSE_TIMEOUT_SECONDS", 15.0, 1.0, 30.0)
        status, payload = _exchange(OP_PARSE, document, timeout)
        if status == STATUS_OK:
            sys.stdout.buffer.write(_validated_result(payload))
            return STATUS_OK
        if status == STATUS_REJECTED:
            return STATUS_REJECTED
        return STATUS_INFRASTRUCTURE_ERROR
    except ParserClientRejected:
        return STATUS_REJECTED
    except (OSError, ConnectionError, TimeoutError):
        return STATUS_INFRASTRUCTURE_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
