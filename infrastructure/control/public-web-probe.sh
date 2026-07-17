#!/usr/bin/env bash
set -euo pipefail

PUBLIC_WEB_PROBE_URL="${PUBLIC_WEB_PROBE_URL:-}"
PUBLIC_WEB_PROBE_METRICS_FILE="${PUBLIC_WEB_PROBE_METRICS_FILE:-/var/lib/node_exporter/textfile_collector/lunchlineup_public_web.prom}"
PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE="${PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE:-/opt/lunchlineup/current/DEPLOYED_GIT_SHA}"
PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS="${PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS:-5}"
PUBLIC_WEB_PROBE_MAX_TIME_SECONDS="${PUBLIC_WEB_PROBE_MAX_TIME_SECONDS:-15}"
PUBLIC_WEB_PROBE_MAX_BYTES="${PUBLIC_WEB_PROBE_MAX_BYTES:-262144}"
PUBLIC_WEB_PROBE_CURL_BIN="${PUBLIC_WEB_PROBE_CURL_BIN:-/usr/bin/curl}"
PUBLIC_WEB_PROBE_PYTHON_BIN="${PUBLIC_WEB_PROBE_PYTHON_BIN:-/usr/bin/python3}"

metrics_dir="$(dirname "$PUBLIC_WEB_PROBE_METRICS_FILE")"
mkdir -p "$metrics_dir"
metrics_tmp="$(mktemp "$metrics_dir/lunchlineup_public_web.prom.tmp.XXXXXX")"
body="$(mktemp)"
headers="$(mktemp)"

cleanup() {
  rm -f "$metrics_tmp" "$body" "$headers"
}
trap cleanup EXIT

success=0
http_status=0
duration_seconds=0
reason="probe did not run"
attempt_timestamp="$(date +%s)"

publish_metrics() {
  cat > "$metrics_tmp" <<METRICS
# HELP lunchlineup_public_web_probe_success Whether the bounded public HTTPS root probe passed.
# TYPE lunchlineup_public_web_probe_success gauge
lunchlineup_public_web_probe_success $success
# HELP lunchlineup_public_web_probe_http_status Last public HTTPS response status, or zero when no response completed.
# TYPE lunchlineup_public_web_probe_http_status gauge
lunchlineup_public_web_probe_http_status $http_status
# HELP lunchlineup_public_web_probe_duration_seconds Duration of the last bounded public HTTPS request.
# TYPE lunchlineup_public_web_probe_duration_seconds gauge
lunchlineup_public_web_probe_duration_seconds $duration_seconds
# HELP lunchlineup_public_web_probe_last_attempt_timestamp_seconds Unix timestamp of the last public HTTPS probe attempt.
# TYPE lunchlineup_public_web_probe_last_attempt_timestamp_seconds gauge
lunchlineup_public_web_probe_last_attempt_timestamp_seconds $attempt_timestamp
METRICS
  chmod 0644 "$metrics_tmp"
  mv "$metrics_tmp" "$PUBLIC_WEB_PROBE_METRICS_FILE"
}

fail_probe() {
  reason="$1"
  publish_metrics
  echo "public_web_probe_failed reason=$reason status=$http_status duration_seconds=$duration_seconds" >&2
  exit 1
}

for value in \
  "$PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS" \
  "$PUBLIC_WEB_PROBE_MAX_TIME_SECONDS" \
  "$PUBLIC_WEB_PROBE_MAX_BYTES"
do
  [[ "$value" =~ ^[1-9][0-9]*$ ]] || fail_probe "probe bounds must be positive integers"
done

[[ -x "$PUBLIC_WEB_PROBE_PYTHON_BIN" ]] || fail_probe "python3 executable is unavailable"
validated_endpoint=""
if ! validated_endpoint="$("$PUBLIC_WEB_PROBE_PYTHON_BIN" - "$PUBLIC_WEB_PROBE_URL" <<'PY'
import ipaddress
import socket
import sys
from urllib.parse import urlsplit

parsed = urlsplit(sys.argv[1])
host = (parsed.hostname or "").lower()

if parsed.scheme != "https" or not host:
    raise SystemExit("probe URL must use HTTPS and include a hostname")
if parsed.username or parsed.password or parsed.query or parsed.fragment:
    raise SystemExit("probe URL must not contain credentials, a query, or a fragment")
if parsed.path not in ("", "/") or parsed.port not in (None, 443):
    raise SystemExit("probe URL must be the canonical HTTPS root on port 443")
if "." not in host or host == "localhost" or host.endswith((".local", ".test", ".invalid", ".example")):
    raise SystemExit("probe URL must use a public hostname")

try:
    resolved = {item[4][0] for item in socket.getaddrinfo(host, 443, type=socket.SOCK_STREAM)}
except OSError as error:
    raise SystemExit(f"probe hostname resolution failed: {error}") from error

if not resolved:
    raise SystemExit("probe hostname did not resolve")
addresses = [ipaddress.ip_address(value) for value in resolved]
if any(not address.is_global for address in addresses):
    raise SystemExit("probe hostname must resolve only to public IP addresses")

selected = sorted(addresses, key=lambda address: (address.version, str(address)))[0]
print(host)
print(selected)
PY
  )"
then
  fail_probe "PUBLIC_WEB_PROBE_URL is not a canonical public HTTPS root"
fi
mapfile -t validated_endpoint_lines <<< "$validated_endpoint"
validated_host="${validated_endpoint_lines[0]:-}"
validated_ip="${validated_endpoint_lines[1]:-}"
[[ -n "$validated_host" && -n "$validated_ip" ]] || fail_probe "public hostname validation returned no endpoint"
if [[ "$validated_ip" == *:* ]]; then
  validated_ip="[$validated_ip]"
fi

[[ -x "$PUBLIC_WEB_PROBE_CURL_BIN" ]] || fail_probe "curl executable is unavailable"
[[ -f "$PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE" ]] || fail_probe "deployed release pointer is missing"
expected_release="$(tr -d '[:space:]' < "$PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE")"
[[ "$expected_release" =~ ^[a-fA-F0-9]{40}$ ]] || fail_probe "deployed release pointer is invalid"

probe_url="${PUBLIC_WEB_PROBE_URL%/}/?lunchlineup_public_probe=$attempt_timestamp"
curl_exit=0
curl_result="$({ "$PUBLIC_WEB_PROBE_CURL_BIN" \
  --silent \
  --show-error \
  --proto '=https' \
  --tlsv1.2 \
  --connect-timeout "$PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS" \
  --max-time "$PUBLIC_WEB_PROBE_MAX_TIME_SECONDS" \
  --max-filesize "$PUBLIC_WEB_PROBE_MAX_BYTES" \
  --max-redirs 0 \
  --resolve "$validated_host:443:$validated_ip" \
  --header 'Cache-Control: no-cache' \
  --dump-header "$headers" \
  --output "$body" \
  --write-out '%{http_code} %{time_total}' \
  "$probe_url"; } 2>/dev/null)" || curl_exit=$?

read -r http_status duration_seconds <<< "$curl_result"
[[ "$http_status" =~ ^[0-9]{3}$ ]] || http_status=0
[[ "$duration_seconds" =~ ^[0-9]+([.][0-9]+)?$ ]] || duration_seconds=0
(( curl_exit == 0 )) || fail_probe "bounded HTTPS request failed with curl exit $curl_exit"
[[ "$http_status" == "200" ]] || fail_probe "public edge returned HTTP $http_status"

content_type="$(awk 'BEGIN { IGNORECASE=1 } /^Content-Type:/ { sub(/\r$/, ""); sub(/^[^:]+:[[:space:]]*/, ""); value=$0 } END { print value }' "$headers")"
served_release="$(awk 'BEGIN { IGNORECASE=1 } /^X-LunchLineUp-Release:/ { sub(/\r$/, ""); sub(/^[^:]+:[[:space:]]*/, ""); value=$0 } END { print value }' "$headers")"
[[ "$content_type" == text/html* ]] || fail_probe "public edge did not return HTML"
[[ "$served_release" == "$expected_release" ]] || fail_probe "public edge release header does not match deployed truth"
grep -Fq '<h1>LunchLineup</h1>' "$body" || fail_probe "public page is missing the LunchLineup heading"
grep -Fq '/_next/static/' "$body" || fail_probe "public page is missing a Next.js static asset marker"

success=1
reason="ok"
publish_metrics
echo "public_web_probe_ok status=$http_status duration_seconds=$duration_seconds release=$served_release"
