"""No-network, one-document service boundary for hostile PDF parsing."""

from __future__ import annotations

import json
import os
from pathlib import Path
import signal
import socket
import stat
import subprocess
import sys
import tempfile

from .pdf_sandbox import (
    DEFAULT_SOCKET_PATH,
    MAX_RESULT_BYTES,
    OP_HEALTH,
    OP_PARSE,
    REQUEST_HEADER,
    RESPONSE_HEADER,
    STATUS_INFRASTRUCTURE_ERROR,
    STATUS_OK,
    STATUS_REJECTED,
    _bounded_float,
    _bounded_int,
    _maximum_document_bytes,
    _recv_exact,
)


_LIMIT_ENV_NAMES = (
    "WORKER_MAX_AVAILABILITY_PDF_BYTES",
    "WORKER_MAX_AVAILABILITY_PDF_PAGES",
    "WORKER_MAX_AVAILABILITY_TEXT_CHARS",
    "WORKER_MAX_AVAILABILITY_ROWS",
    "WORKER_PDF_PARSE_MEMORY_BYTES",
    "WORKER_PDF_PARSE_CPU_SECONDS",
)


def _child_environment() -> dict[str, str]:
    environment = {
        "HOME": "/home/lunchlineup",
        "PATH": "/usr/local/bin:/usr/bin:/bin",
        "PYTHONHASHSEED": "random",
        "PYTHONPATH": str(Path(__file__).resolve().parents[2]),
        "TMPDIR": "/tmp",
    }
    for name in _LIMIT_ENV_NAMES:
        value = os.getenv(name)
        if value is not None:
            environment[name] = value
    return environment


def _apply_resource_limits() -> None:
    if os.name != "posix":
        return
    import resource

    memory_bytes = _bounded_int(
        "WORKER_PDF_PARSE_MEMORY_BYTES",
        256 * 1024 * 1024,
        64 * 1024 * 1024,
        512 * 1024 * 1024,
    )
    cpu_seconds = _bounded_int("WORKER_PDF_PARSE_CPU_SECONDS", 10, 1, 30)
    resource.setrlimit(resource.RLIMIT_AS, (memory_bytes, memory_bytes))
    resource.setrlimit(resource.RLIMIT_CPU, (cpu_seconds, cpu_seconds))
    resource.setrlimit(resource.RLIMIT_NOFILE, (32, 32))
    resource.setrlimit(resource.RLIMIT_FSIZE, (MAX_RESULT_BYTES, MAX_RESULT_BYTES))
    resource.setrlimit(resource.RLIMIT_CORE, (0, 0))


def _run_job(path: Path) -> int:
    _apply_resource_limits()
    from .pdf_parser import AvailabilityParseError, AvailabilityParser

    try:
        result = AvailabilityParser().parse_document(str(path))
    except AvailabilityParseError:
        return STATUS_REJECTED
    except Exception:
        return STATUS_INFRASTRUCTURE_ERROR
    sys.stdout.write(json.dumps(result, separators=(",", ":"), ensure_ascii=True))
    return STATUS_OK


def _terminate_process_group(process: subprocess.Popen[bytes]) -> None:
    if os.name == "posix":
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except ProcessLookupError:
            pass
    elif process.poll() is None:
        process.kill()
    try:
        process.wait(timeout=2)
    except (subprocess.TimeoutExpired, ProcessLookupError):
        if process.poll() is None:
            process.kill()
            process.wait()


def _execute_parser(document: bytes) -> tuple[int, bytes]:
    if not document.startswith(b"%PDF-") or len(document) > _maximum_document_bytes():
        return STATUS_REJECTED, b""
    timeout = _bounded_float("PARSER_JOB_TIMEOUT_SECONDS", 10.0, 1.0, 25.0)
    with tempfile.TemporaryDirectory(prefix="pdf-job-", dir="/tmp") as directory:
        source_path = Path(directory) / "document.pdf"
        with source_path.open("xb") as source:
            source.write(document)
        os.chmod(source_path, 0o400)
        with tempfile.TemporaryFile(dir="/tmp") as output:
            process = subprocess.Popen(
                [sys.executable, "-m", "src.parser.pdf_service", "--job", str(source_path)],
                stdin=subprocess.DEVNULL,
                stdout=output,
                stderr=subprocess.DEVNULL,
                env=_child_environment(),
                close_fds=True,
                start_new_session=os.name == "posix",
            )
            try:
                return_code = process.wait(timeout=timeout)
            except subprocess.TimeoutExpired:
                return_code = STATUS_REJECTED
            finally:
                _terminate_process_group(process)
            if return_code == STATUS_REJECTED or return_code < 0:
                return STATUS_REJECTED, b""
            if return_code != STATUS_OK:
                return STATUS_INFRASTRUCTURE_ERROR, b""
            output.seek(0, os.SEEK_END)
            size = output.tell()
            if size <= 0 or size > MAX_RESULT_BYTES:
                return STATUS_REJECTED, b""
            output.seek(0)
            payload = output.read(MAX_RESULT_BYTES)
            try:
                if not isinstance(json.loads(payload.decode("ascii")), dict):
                    return STATUS_REJECTED, b""
            except (UnicodeDecodeError, json.JSONDecodeError):
                return STATUS_REJECTED, b""
            return STATUS_OK, payload


def _handle_request(operation: bytes, payload: bytes) -> tuple[int, bytes]:
    if operation == OP_HEALTH and not payload:
        return STATUS_OK, b""
    if operation != OP_PARSE or not payload or len(payload) > _maximum_document_bytes():
        return STATUS_REJECTED, b""
    return _execute_parser(payload)


def _send_response(connection: socket.socket, status: int, payload: bytes) -> None:
    connection.sendall(RESPONSE_HEADER.pack(status, len(payload)))
    if payload:
        connection.sendall(payload)


def _serve_connection(connection: socket.socket) -> bool:
    parsed_document = False
    try:
        connection.settimeout(5.0)
        operation, length = REQUEST_HEADER.unpack(_recv_exact(connection, REQUEST_HEADER.size))
        parsed_document = operation == OP_PARSE
        if length > _maximum_document_bytes():
            _send_response(connection, STATUS_REJECTED, b"")
            return parsed_document
        payload = _recv_exact(connection, length) if length else b""
        status, response = _handle_request(operation, payload)
        _send_response(connection, status, response)
    except (OSError, ConnectionError, TimeoutError, ValueError):
        try:
            _send_response(connection, STATUS_INFRASTRUCTURE_ERROR, b"")
        except OSError:
            pass
    return parsed_document


def _prepare_socket_path(path: Path) -> None:
    path.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
    try:
        metadata = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(metadata.st_mode):
        raise RuntimeError("parser socket path is not a socket")
    path.unlink()


def _serve_one_document() -> int:
    socket_path = Path(os.getenv("PARSER_SOCKET_PATH", DEFAULT_SOCKET_PATH))
    _prepare_socket_path(socket_path)
    previous_umask = os.umask(0o077)
    try:
        with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as listener:
            listener.bind(str(socket_path))
            os.chmod(socket_path, 0o600)
            listener.listen(8)
            while True:
                connection, _ = listener.accept()
                with connection:
                    try:
                        parsed_document = _serve_connection(connection)
                    except (OSError, ConnectionError, TimeoutError, ValueError):
                        try:
                            _send_response(connection, STATUS_INFRASTRUCTURE_ERROR, b"")
                        except OSError:
                            pass
                        parsed_document = False
                if parsed_document:
                    return STATUS_OK
    finally:
        os.umask(previous_umask)
        try:
            socket_path.unlink()
        except FileNotFoundError:
            pass


def main() -> int:
    if len(sys.argv) == 3 and sys.argv[1] == "--job":
        return _run_job(Path(sys.argv[2]))
    if len(sys.argv) != 1 or os.name != "posix":
        return STATUS_INFRASTRUCTURE_ERROR
    try:
        return _serve_one_document()
    except Exception:
        return STATUS_INFRASTRUCTURE_ERROR


if __name__ == "__main__":
    raise SystemExit(main())
