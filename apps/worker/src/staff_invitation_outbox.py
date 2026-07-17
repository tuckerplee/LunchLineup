from __future__ import annotations

import asyncio
import base64
from dataclasses import dataclass
import hashlib
import hmac
import html
import json
import logging
import os
from typing import Callable, Protocol
from urllib import error, request
from urllib.parse import urlsplit

from cryptography.hazmat.primitives.ciphers.aead import AESGCM
from prometheus_client import Counter, Gauge

from src.staff_invitation_store import (
    InvitationDiagnostics,
    InvitationItem,
    InvitationLeaseLostError,
    PostgresInvitationStore,
)

logger = logging.getLogger("worker.staff_invitation_outbox")

DELIVERY_TOTAL = Counter(
    "lunchlineup_staff_invitation_outbox_total",
    "Staff invitation outbox outcomes",
    ["status"],
)
SWEEP_FAILURES = Counter(
    "lunchlineup_staff_invitation_sweep_failures_total",
    "Staff invitation sweeps that failed before completion",
)
PROVIDER_FAILURES = Counter(
    "lunchlineup_staff_invitation_provider_failures_total",
    "Staff invitation provider failures by retryability",
    ["kind"],
)
SWEEP_RUNNING = Gauge(
    "lunchlineup_staff_invitation_sweep_running",
    "Whether the staff invitation sweep task is running",
)
SWEEP_READY = Gauge(
    "lunchlineup_staff_invitation_sweep_ready",
    "Whether the staff invitation sweep most recently completed successfully",
)
SWEEP_LAST_SUCCESS = Gauge(
    "lunchlineup_staff_invitation_sweep_last_success_unixtime",
    "Unix time of the last successful staff invitation sweep",
)
SWEEP_MAX_STALENESS = Gauge(
    "lunchlineup_staff_invitation_sweep_max_staleness_seconds",
    "Maximum healthy age of the last successful staff invitation sweep",
)
DUE = Gauge(
    "lunchlineup_staff_invitation_due",
    "Bounded count of staff invitation rows currently due",
)
EXPIRED_LEASES = Gauge(
    "lunchlineup_staff_invitation_expired_leases",
    "Bounded count of expired staff invitation leases",
)
DEAD_LETTERED = Gauge(
    "lunchlineup_staff_invitation_dead_lettered",
    "Bounded count of dead-lettered staff invitations",
)
RECENT_PROVIDER_FAILURES = Gauge(
    "lunchlineup_staff_invitation_recent_provider_failures",
    "Bounded provider failures inside the health window",
)
SYSTEMIC_PROVIDER_FAILURE = Gauge(
    "lunchlineup_staff_invitation_systemic_provider_failure",
    "Whether provider failures meet the configured outage threshold",
)
LAST_DEAD_LETTER = Gauge(
    "lunchlineup_staff_invitation_last_dead_letter_unixtime",
    "Unix time of the latest staff invitation dead letter",
)
LAST_PROVIDER_FAILURE = Gauge(
    "lunchlineup_staff_invitation_last_provider_failure_unixtime",
    "Unix time of the latest staff invitation provider failure",
)


class RetryableInvitationError(RuntimeError):
    pass


class PermanentInvitationError(RuntimeError):
    pass


class RetryableProviderError(RetryableInvitationError):
    pass


class ProviderAuthConfigurationError(RetryableProviderError):
    pass


class SystemicProviderInvitationError(RetryableInvitationError):
    pass


class ProviderRejectedError(PermanentInvitationError):
    pass


class InvalidInvitationEnvelope(PermanentInvitationError):
    pass


class InvitationStore(Protocol):
    max_attempts: int

    def claim_batch(self, limit: int) -> list[InvitationItem]: ...
    def deliver_if_eligible(
        self,
        item: InvitationItem,
        recipient_email: str,
        deliver: Callable[[], str],
    ) -> str: ...
    def mark_failed(self, item: InvitationItem, error_code: str, terminal: bool) -> None: ...
    def diagnostics(self, provider_window_seconds: int) -> InvitationDiagnostics: ...


class InvitationProvider(Protocol):
    def send(self, item: InvitationItem, payload: dict[str, str]) -> str: ...


@dataclass(frozen=True)
class InvitationRuntimeConfig:
    max_attempts: int
    lease_seconds: int
    sweep_batch_size: int
    sweep_interval_seconds: int
    provider_timeout_seconds: int
    retry_base_seconds: int
    retry_max_seconds: int
    retry_jitter_ratio: float
    provider_failure_threshold: int
    provider_health_window_seconds: int
    diagnostics_count_cap: int
    sweep_max_staleness_seconds: int


def _bounded_int(name: str, default: int, minimum: int, maximum: int) -> int:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = int(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be an integer") from exc
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def _bounded_float(name: str, default: float, minimum: float, maximum: float) -> float:
    raw = os.getenv(name, str(default)).strip()
    try:
        value = float(raw)
    except ValueError as exc:
        raise RuntimeError(f"{name} must be numeric") from exc
    if value < minimum or value > maximum:
        raise RuntimeError(f"{name} must be between {minimum} and {maximum}")
    return value


def staff_invitation_outbox_enabled() -> bool:
    configured = os.getenv("STAFF_INVITATION_OUTBOX_ENABLED", "false")
    if configured not in ("true", "false"):
        raise RuntimeError("STAFF_INVITATION_OUTBOX_ENABLED must be exactly true or false")
    return configured == "true"


def invitation_runtime_config() -> InvitationRuntimeConfig:
    config = InvitationRuntimeConfig(
        max_attempts=_bounded_int("STAFF_INVITATION_MAX_ATTEMPTS", 8, 1, 8),
        lease_seconds=_bounded_int("STAFF_INVITATION_LEASE_SECONDS", 120, 30, 900),
        sweep_batch_size=_bounded_int("STAFF_INVITATION_SWEEP_BATCH_SIZE", 25, 1, 100),
        sweep_interval_seconds=_bounded_int(
            "STAFF_INVITATION_SWEEP_INTERVAL_SECONDS", 10, 1, 300
        ),
        provider_timeout_seconds=_bounded_int(
            "STAFF_INVITATION_PROVIDER_TIMEOUT_SECONDS", 10, 2, 30
        ),
        retry_base_seconds=_bounded_int(
            "STAFF_INVITATION_RETRY_BASE_SECONDS", 15, 1, 300
        ),
        retry_max_seconds=_bounded_int(
            "STAFF_INVITATION_RETRY_MAX_SECONDS", 3600, 30, 86400
        ),
        retry_jitter_ratio=_bounded_float(
            "STAFF_INVITATION_RETRY_JITTER_RATIO", 0.25, 0.0, 0.5
        ),
        provider_failure_threshold=_bounded_int(
            "STAFF_INVITATION_PROVIDER_FAILURE_THRESHOLD", 3, 2, 100
        ),
        provider_health_window_seconds=_bounded_int(
            "STAFF_INVITATION_PROVIDER_HEALTH_WINDOW_SECONDS", 300, 30, 3600
        ),
        diagnostics_count_cap=_bounded_int(
            "STAFF_INVITATION_DIAGNOSTICS_COUNT_CAP", 1000, 10, 10000
        ),
        sweep_max_staleness_seconds=_bounded_int(
            "STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS", 60, 2, 3600
        ),
    )
    if config.retry_max_seconds < config.retry_base_seconds:
        raise RuntimeError("STAFF_INVITATION_RETRY_MAX_SECONDS must not be below retry base")
    if config.lease_seconds <= config.provider_timeout_seconds:
        raise RuntimeError(
            "STAFF_INVITATION_LEASE_SECONDS must exceed provider timeout"
        )
    if config.provider_health_window_seconds < config.sweep_interval_seconds * 2:
        raise RuntimeError(
            "STAFF_INVITATION_PROVIDER_HEALTH_WINDOW_SECONDS must cover at least two sweeps"
        )
    if config.provider_failure_threshold > config.diagnostics_count_cap:
        raise RuntimeError(
            "STAFF_INVITATION_PROVIDER_FAILURE_THRESHOLD must not exceed the diagnostics cap"
        )
    if config.sweep_max_staleness_seconds < config.sweep_interval_seconds * 2:
        raise RuntimeError(
            "STAFF_INVITATION_SWEEP_MAX_STALENESS_SECONDS must cover at least two sweeps"
        )
    return config


def _decode_key(configured: str) -> bytes:
    try:
        if len(configured) == 64 and all(character in "0123456789abcdefABCDEF" for character in configured):
            key = bytes.fromhex(configured)
        else:
            normalized = configured.replace("-", "+").replace("_", "/")
            padded = normalized + "=" * ((4 - len(normalized) % 4) % 4)
            key = base64.b64decode(padded, validate=True)
            if base64.b64encode(key).decode("ascii").rstrip("=") != normalized.rstrip("="):
                raise ValueError("non-canonical base64 key")
    except (ValueError, TypeError) as exc:
        raise RuntimeError(
            "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY must decode to exactly 32 bytes"
        ) from exc
    if len(key) != 32:
        raise RuntimeError(
            "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY must decode to exactly 32 bytes"
        )
    return key


def encryption_key() -> bytes:
    configured = os.getenv("STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY", "").strip()
    if not configured:
        raise RuntimeError("STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY is required")
    return _decode_key(configured)


def validate_staff_invitation_outbox_config() -> None:
    enabled = staff_invitation_outbox_enabled()
    production = os.getenv("ENVIRONMENT", os.getenv("NODE_ENV", "development")).lower() == "production"
    if not enabled:
        if production:
            raise RuntimeError("STAFF_INVITATION_OUTBOX_ENABLED must be true in production")
        return
    for name in (
        "DATABASE_URL",
        "PLATFORM_ADMIN_DB_CONTEXT_SECRET",
        "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY",
        "RESEND_API_KEY",
        "EMAIL_FROM",
        "APP_ORIGIN",
    ):
        if not os.getenv(name, "").strip():
            raise RuntimeError(f"{name} is required when staff invitation delivery is enabled")
    key = encryption_key()
    email_from = os.environ["EMAIL_FROM"]
    if "\r" in email_from or "\n" in email_from or "@" not in email_from:
        raise RuntimeError("EMAIL_FROM must be a valid sender address")
    invitation_login_url()
    password_reset_key = os.getenv("PASSWORD_RESET_OUTBOX_ENCRYPTION_KEY", "").strip()
    if password_reset_key:
        try:
            if hmac.compare_digest(key, _decode_other_key(password_reset_key)):
                raise RuntimeError(
                    "STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY must be dedicated to staff invitations"
                )
        except ValueError:
            pass
    invitation_runtime_config()


def _decode_other_key(configured: str) -> bytes:
    try:
        if len(configured) == 64 and all(
            character in "0123456789abcdefABCDEF" for character in configured
        ):
            return bytes.fromhex(configured)
        normalized = configured.replace("-", "+").replace("_", "/")
        padded = normalized + "=" * ((4 - len(normalized) % 4) % 4)
        key = base64.b64decode(padded, validate=True)
        if base64.b64encode(key).decode("ascii").rstrip("=") != normalized.rstrip("="):
            raise ValueError("non-canonical base64 key")
        return key
    except (ValueError, TypeError) as exc:
        raise ValueError("invalid peer key") from exc


def invitation_aad(item: InvitationItem) -> bytes:
    return json.dumps({
        "tenantId": item.tenant_id,
        "outboxId": item.id,
        "userId": item.user_id,
        "recipientHash": item.recipient_hash,
        "purpose": item.purpose,
        "payloadVersion": item.payload_version,
    }, separators=(",", ":")).encode("utf-8")


def decrypt_invitation(item: InvitationItem) -> dict[str, str]:
    key = encryption_key()
    expected_key_ref = hashlib.sha256(key).hexdigest()[:16]
    if not hmac.compare_digest(expected_key_ref, item.encryption_key_ref):
        raise InvalidInvitationEnvelope("staff invitation envelope key reference mismatch")
    if item.payload_version != 1 or item.purpose != "STAFF_INVITATION":
        raise InvalidInvitationEnvelope("staff invitation envelope metadata is unsupported")
    try:
        plaintext = AESGCM(key).decrypt(
            item.encryption_nonce,
            item.encrypted_payload + item.encryption_tag,
            invitation_aad(item),
        )
        payload = json.loads(plaintext.decode("utf-8"))
        if not isinstance(payload, dict) or set(payload) != {"recipient", "template"}:
            raise ValueError("unexpected payload fields")
        recipient = payload.get("recipient")
        if (
            not isinstance(recipient, str)
            or not 3 <= len(recipient) <= 320
            or "@" not in recipient
            or payload.get("template") != "staff_invitation"
        ):
            raise ValueError("invalid invitation payload")
        expected_hash = hmac.new(key, recipient.encode("utf-8"), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(expected_hash, item.recipient_hash):
            raise ValueError("recipient hash mismatch")
        return {"recipient": recipient, "template": "staff_invitation"}
    except InvalidInvitationEnvelope:
        raise
    except Exception as exc:
        raise InvalidInvitationEnvelope("staff invitation envelope authentication failed") from exc


def provider_idempotency_key(outbox_id: str) -> str:
    return f"staff-invitation/{outbox_id}"


def invitation_login_url() -> str:
    configured = os.getenv("APP_ORIGIN", "").strip()
    if not configured:
        raise RuntimeError("APP_ORIGIN is required when staff invitation delivery is enabled")
    if "\\" in configured or any(character.isspace() for character in configured):
        raise RuntimeError("APP_ORIGIN must be a canonical absolute application origin")
    parsed = urlsplit(configured)
    try:
        parsed.port
    except ValueError as exc:
        raise RuntimeError("APP_ORIGIN must contain a valid port") from exc
    production = os.getenv("ENVIRONMENT", os.getenv("NODE_ENV", "development")).lower() == "production"
    if (
        parsed.scheme not in ("http", "https")
        or not parsed.hostname
        or parsed.username is not None
        or parsed.password is not None
        or parsed.query
        or parsed.fragment
        or parsed.path not in ("", "/")
        or (production and parsed.scheme != "https")
    ):
        requirement = "an absolute HTTPS origin" if production else "a canonical absolute application origin"
        raise RuntimeError(f"APP_ORIGIN must be {requirement} without credentials, path, query, or fragment")
    return f"{parsed.scheme}://{parsed.netloc}/auth/login"


class ResendInvitationProvider:
    def __init__(self, timeout_seconds: int | None = None):
        self.timeout_seconds = timeout_seconds or _bounded_int(
            "STAFF_INVITATION_PROVIDER_TIMEOUT_SECONDS", 10, 2, 30
        )

    def send(self, item: InvitationItem, payload: dict[str, str]) -> str:
        subject = "You have been invited to LunchLineup"
        login_url = invitation_login_url()
        escaped_login_url = html.escape(login_url, quote=True)
        body = json.dumps({
            "from": os.environ["EMAIL_FROM"],
            "to": [payload["recipient"]],
            "subject": subject,
            "html": (
                "<p>You have been invited to LunchLineup.</p>"
                "<p>Sign in with this email address to access your workplace schedule.</p>"
                f'<p><a href="{escaped_login_url}">Sign in to LunchLineup</a></p>'
            ),
            "text": (
                "You have been invited to LunchLineup. "
                "Sign in with this email address to access your workplace schedule: "
                f"{login_url}"
            ),
        }, separators=(",", ":")).encode("utf-8")
        req = request.Request(
            "https://api.resend.com/emails",
            data=body,
            method="POST",
            headers={
                "Authorization": f"Bearer {os.environ['RESEND_API_KEY']}",
                "Content-Type": "application/json",
                "Idempotency-Key": provider_idempotency_key(item.id),
            },
        )
        try:
            with request.urlopen(req, timeout=self.timeout_seconds) as response:
                if response.status < 200 or response.status >= 300:
                    raise RetryableProviderError("staff invitation provider response was unsuccessful")
                raw = response.read(65537)
                if len(raw) > 65536:
                    raise RetryableProviderError("staff invitation provider response was oversized")
                result = json.loads(raw.decode("utf-8"))
                provider_message_id = result.get("id") if isinstance(result, dict) else None
                if not isinstance(provider_message_id, str) or not 1 <= len(provider_message_id) <= 255:
                    raise RetryableProviderError("staff invitation provider response was invalid")
                return provider_message_id
        except error.HTTPError as exc:
            if exc.code in (401, 403):
                raise ProviderAuthConfigurationError(
                    "staff invitation provider authentication or configuration failed"
                ) from exc
            if exc.code in (408, 409, 425, 429) or exc.code >= 500:
                raise RetryableProviderError("staff invitation provider is temporarily unavailable") from exc
            if exc.code in (400, 422):
                raise ProviderRejectedError("staff invitation provider rejected delivery") from exc
            raise RetryableProviderError("staff invitation provider response was unsuccessful") from exc
        except (error.URLError, TimeoutError) as exc:
            raise RetryableProviderError("staff invitation provider request failed") from exc
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise RetryableProviderError("staff invitation provider response was invalid") from exc


def _store_from_config(config: InvitationRuntimeConfig | None = None) -> PostgresInvitationStore:
    runtime = config or invitation_runtime_config()
    return PostgresInvitationStore(
        max_attempts=runtime.max_attempts,
        lease_seconds=runtime.lease_seconds,
        retry_base_seconds=runtime.retry_base_seconds,
        retry_max_seconds=runtime.retry_max_seconds,
        retry_jitter_ratio=runtime.retry_jitter_ratio,
        diagnostics_count_cap=runtime.diagnostics_count_cap,
    )


def _failure_code(exc: Exception, terminal: bool) -> str:
    if isinstance(exc, InvalidInvitationEnvelope):
        return "ENVELOPE_INVALID"
    if isinstance(exc, ProviderRejectedError):
        return "PROVIDER_REJECTED"
    if isinstance(exc, RetryableProviderError):
        return "RETRIES_EXHAUSTED" if terminal else "PROVIDER_RETRYABLE"
    return "RETRIES_EXHAUSTED" if terminal else "DELIVERY_RETRYABLE"


async def deliver_invitation(
    item: InvitationItem,
    *,
    store: InvitationStore,
    provider: InvitationProvider,
) -> str:
    try:
        payload = decrypt_invitation(item)
        outcome = await asyncio.to_thread(
            store.deliver_if_eligible,
            item,
            payload["recipient"],
            lambda: provider.send(item, payload),
        )
        DELIVERY_TOTAL.labels(status=outcome).inc()
        if outcome != "delivered":
            logger.warning(
                "Staff invitation terminalized outcome=%s outbox_ref=%s attempts=%s",
                outcome,
                item.id,
                item.attempts,
            )
        return outcome
    except InvitationLeaseLostError:
        DELIVERY_TOTAL.labels(status="lease_lost").inc()
        raise
    except Exception as exc:
        terminal = isinstance(exc, PermanentInvitationError) or item.attempts >= store.max_attempts
        error_code = _failure_code(exc, terminal)
        await asyncio.to_thread(store.mark_failed, item, error_code, terminal)
        status = "dead_lettered" if terminal else "retrying"
        DELIVERY_TOTAL.labels(status=status).inc()
        if isinstance(exc, ProviderAuthConfigurationError):
            PROVIDER_FAILURES.labels(kind="terminal" if terminal else "systemic").inc()
        elif isinstance(exc, RetryableProviderError):
            PROVIDER_FAILURES.labels(kind="terminal" if terminal else "retryable").inc()
        elif isinstance(exc, ProviderRejectedError):
            PROVIDER_FAILURES.labels(kind="permanent").inc()
        logger.log(
            logging.ERROR if terminal else logging.WARNING,
            "Staff invitation delivery failed outcome=%s reason=%s outbox_ref=%s attempts=%s",
            status,
            error_code,
            item.id,
            item.attempts,
        )
        if terminal:
            raise PermanentInvitationError("staff invitation delivery was dead-lettered") from exc
        if isinstance(exc, ProviderAuthConfigurationError):
            raise SystemicProviderInvitationError(
                "staff invitation delivery will retry after provider configuration is restored"
            ) from exc
        raise RetryableInvitationError("staff invitation delivery will retry") from exc


def _update_diagnostics_metrics(diagnostics: InvitationDiagnostics, threshold: int) -> bool:
    DUE.set(diagnostics.due)
    EXPIRED_LEASES.set(diagnostics.expired_leases)
    DEAD_LETTERED.set(diagnostics.dead_lettered)
    RECENT_PROVIDER_FAILURES.set(diagnostics.recent_provider_failures)
    LAST_DEAD_LETTER.set(diagnostics.last_dead_letter_unixtime)
    LAST_PROVIDER_FAILURE.set(diagnostics.last_provider_failure_unixtime)
    systemic = diagnostics.recent_provider_failures >= threshold
    SYSTEMIC_PROVIDER_FAILURE.set(int(systemic))
    return systemic


async def sweep_staff_invitation_outbox(
    *,
    store: InvitationStore | None = None,
    provider: InvitationProvider | None = None,
    batch_size: int | None = None,
    runtime_config: InvitationRuntimeConfig | None = None,
) -> dict[str, int]:
    runtime = runtime_config or invitation_runtime_config()
    active_store = store or _store_from_config(runtime)
    active_provider = provider or ResendInvitationProvider(runtime.provider_timeout_seconds)
    limit = batch_size if batch_size is not None else runtime.sweep_batch_size
    if limit < 1 or limit > 100:
        raise ValueError("staff invitation sweep batch must be between 1 and 100")
    items = await asyncio.to_thread(active_store.claim_batch, limit)
    outcomes = {
        "claimed": len(items),
        "delivered": 0,
        "retrying": 0,
        "dead_lettered": 0,
        "cancelled": 0,
        "suppressed": 0,
        "lease_lost": 0,
        "provider_auth_configuration_failure": 0,
    }
    for item in items:
        try:
            outcome = await deliver_invitation(item, store=active_store, provider=active_provider)
        except InvitationLeaseLostError:
            outcomes["lease_lost"] += 1
        except SystemicProviderInvitationError:
            outcomes["retrying"] += 1
            outcomes["provider_auth_configuration_failure"] = 1
        except RetryableInvitationError:
            outcomes["retrying"] += 1
        except PermanentInvitationError:
            outcomes["dead_lettered"] += 1
        else:
            outcomes[outcome] += 1

    diagnostics = await asyncio.to_thread(
        active_store.diagnostics,
        runtime.provider_health_window_seconds,
    )
    diagnostic_systemic_failure = _update_diagnostics_metrics(
        diagnostics, runtime.provider_failure_threshold
    )
    outcomes["systemic_provider_failure"] = int(
        diagnostic_systemic_failure
        or outcomes["provider_auth_configuration_failure"]
    )
    SYSTEMIC_PROVIDER_FAILURE.set(outcomes["systemic_provider_failure"])
    if outcomes["delivered"]:
        logger.info("Staff invitation outbox delivered=%s", outcomes["delivered"])
    if diagnostics.dead_lettered:
        logger.error("Staff invitation terminal backlog count=%s", diagnostics.dead_lettered)
    return outcomes


async def run_staff_invitation_outbox_loop(
    store: InvitationStore | None = None,
    provider: InvitationProvider | None = None,
) -> None:
    runtime = invitation_runtime_config()
    active_store = store or _store_from_config(runtime)
    active_provider = provider or ResendInvitationProvider(runtime.provider_timeout_seconds)
    SWEEP_RUNNING.set(1)
    SWEEP_READY.set(0)
    SWEEP_MAX_STALENESS.set(runtime.sweep_max_staleness_seconds)
    SYSTEMIC_PROVIDER_FAILURE.set(0)
    auth_configuration_failure_active = False
    try:
        while True:
            try:
                result = await sweep_staff_invitation_outbox(
                    store=active_store,
                    provider=active_provider,
                    runtime_config=runtime,
                )
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                SWEEP_FAILURES.inc()
                SWEEP_READY.set(0)
                logger.error("Staff invitation sweep failed reason=%s", exc.__class__.__name__)
            else:
                if result["provider_auth_configuration_failure"]:
                    auth_configuration_failure_active = True
                elif result["delivered"]:
                    auth_configuration_failure_active = False
                systemic_provider_failure = bool(
                    result["systemic_provider_failure"]
                    or auth_configuration_failure_active
                )
                SYSTEMIC_PROVIDER_FAILURE.set(int(systemic_provider_failure))
                ready = not systemic_provider_failure
                SWEEP_READY.set(int(ready))
                if ready:
                    SWEEP_LAST_SUCCESS.set_to_current_time()
            await asyncio.sleep(runtime.sweep_interval_seconds)
    finally:
        SWEEP_READY.set(0)
        SYSTEMIC_PROVIDER_FAILURE.set(0)
        SWEEP_RUNNING.set(0)
