#!/usr/bin/env node
import { createHash } from "node:crypto";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { tmpdir } from "node:os";

const RETAINED_RECORD_CONFIRM = "purge-expired-retained-records";
const APPLICATION_DATA_CONFIRM = "purge-expired-application-data";
const DEFAULT_TIMEOUT_MS = 30000;
const DEFAULT_MAX_PAGES = 20;

if (process.argv.includes("--help")) {
  console.log("Usage: node scripts/invoke-retained-record-purge.mjs");
  console.log(
    "Calls POST /api/v1/admin/retention/purge-expired with dryRun enabled by default.",
  );
  console.log("");
  console.log("Required environment:");
  console.log(
    "  RETENTION_PURGE_URL=https://lunchlineup.com/api/v1/admin/retention/purge-expired",
  );
  console.log(
    "  RETENTION_PURGE_TOKEN_FILE=/run/secrets/retention_purge_token",
  );
  console.log("");
  console.log("Recommended environment:");
  console.log(
    "  RETENTION_PURGE_PROOF_FILE=/var/lib/lunchlineup/proofs/retention-purge-latest.json",
  );
  console.log(
    "  RETENTION_PURGE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_retention_purge.prom",
  );
  console.log(
    "  RETENTION_PURGE_LOCK_FILE=/var/lock/lunchlineup-retention-purge.lock",
  );
  console.log("  RETENTION_PURGE_MAX_PAGES=20");
  console.log("");
  console.log(
    "Set RETENTION_PURGE_STAGE=application_data or retained_records. Execute mode requires the matching confirmation.",
  );
  process.exit(0);
}

const startedAt = new Date();
let mode = "dry_run";
let stage = "retained_records";
const proofFile = trim(process.env.RETENTION_PURGE_PROOF_FILE);
const metricsFile = trim(process.env.RETENTION_PURGE_METRICS_FILE);
const lockFile =
  trim(process.env.RETENTION_PURGE_LOCK_FILE) ||
  join(tmpdir(), "lunchlineup-retention-purge.lock");
let lockHandle;

try {
  mode = parseBoolean(process.env.RETENTION_PURGE_DRY_RUN, true)
    ? "dry_run"
    : "execute";
  stage = retentionStage(process.env.RETENTION_PURGE_STAGE);
  lockHandle = acquireLock(lockFile);
  const result = await invokeRetentionPurge();
  writeOutputs({ result, status: "ok" });
  console.log(
    [
      "retention_purge_ok",
      `mode=${result.mode}`,
      `http_status=${result.httpStatus}`,
      `candidate_tenants=${result.candidateTenantCount}`,
      `deleted_records=${result.deletedRecordCount}`,
      `failed_tenants=${result.failedTenantCount}`,
      `skipped_tenants=${result.skippedTenantCount}`,
      proofFile ? `proof_file=${proofFile}` : null,
      metricsFile ? `metrics_file=${metricsFile}` : null,
    ]
      .filter(Boolean)
      .join(" "),
  );
} catch (error) {
  const result = error.result ?? failureResult(error);
  try {
    writeOutputs({ result, status: "failed", error });
  } catch (writeError) {
    console.error(
      `Failed to write retention purge proof/metrics: ${writeError.message}`,
    );
  }
  console.error(
    `retention_purge_failed mode=${result.mode} error=${String(error.message ?? error)}`,
  );
  process.exitCode = 1;
} finally {
  releaseLock(lockHandle, lockFile);
}

async function invokeRetentionPurge() {
  const dryRun = mode === "dry_run";
  const confirmation =
    stage === "application_data"
      ? APPLICATION_DATA_CONFIRM
      : RETAINED_RECORD_CONFIRM;
  if (
    !dryRun &&
    trim(process.env.RETENTION_PURGE_EXECUTE_CONFIRM) !== confirmation
  ) {
    throw new Error(
      `RETENTION_PURGE_EXECUTE_CONFIRM=${confirmation} is required for ${stage} execution.`,
    );
  }

  const endpoint = endpointUrl();
  const token = bearerToken();
  const timeoutMs = positiveInteger(
    process.env.RETENTION_PURGE_TIMEOUT_MS,
    DEFAULT_TIMEOUT_MS,
  );
  const maxPages = positiveInteger(
    process.env.RETENTION_PURGE_MAX_PAGES,
    DEFAULT_MAX_PAGES,
  );
  const pageResults = [];
  let continuation = null;

  for (let page = 1; page <= maxPages; page += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), timeoutMs);
    const requestBody = dryRun
      ? { dryRun, stage }
      : { dryRun, stage, executeConfirmation: confirmation };
    if (continuation) requestBody.continuation = continuation;

    try {
      const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": "application/json",
          accept: "application/json",
          "user-agent": "lunchlineup-retention-purge/1",
        },
        body: JSON.stringify(requestBody),
        signal: controller.signal,
      });
      const responseText = await response.text();
      const responsePayload = parseJson(responseText);
      pageResults.push(
        buildResult({
          endpoint,
          httpStatus: response.status,
          responseText,
          responsePayload,
          mode,
          startedAt,
          status: response.ok ? "ok" : "failed",
        }),
      );
      if (!response.ok) {
        const error = new Error(
          `Retention purge endpoint returned HTTP ${response.status}.`,
        );
        error.result = combinePageResults(pageResults, maxPages);
        throw error;
      }
      continuation = validContinuation(responsePayload?.nextContinuation);
      if (!continuation) break;
    } catch (error) {
      if (error.name === "AbortError") {
        const timeoutError = new Error(
          `Retention purge request timed out after ${timeoutMs}ms.`,
        );
        timeoutError.result = combinePageResults(pageResults, maxPages);
        throw timeoutError;
      }
      throw error;
    } finally {
      clearTimeout(timeout);
    }
  }

  const result = combinePageResults(pageResults, maxPages, continuation);
  if (result.failedTenantCount > 0 || result.continuationRemaining) {
    const reason =
      result.failedTenantCount > 0
        ? `${result.failedTenantCount} tenant purge attempt(s) failed.`
        : `Retention purge exceeded the ${maxPages}-page safety bound.`;
    const error = new Error(reason);
    error.result = { ...result, status: "failed" };
    throw error;
  }
  return result;
}

function endpointUrl() {
  const raw = trim(process.env.RETENTION_PURGE_URL);
  if (!raw) {
    throw new Error("RETENTION_PURGE_URL is required.");
  }

  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new Error("RETENTION_PURGE_URL must be a valid URL.");
  }

  if (
    url.protocol !== "https:" &&
    !(url.protocol === "http:" && isLoopbackHost(url.hostname))
  ) {
    throw new Error(
      "RETENTION_PURGE_URL must use https, except loopback http for local/private same-host invocation.",
    );
  }

  if (!url.pathname.endsWith("/api/v1/admin/retention/purge-expired")) {
    throw new Error(
      "RETENTION_PURGE_URL must target /api/v1/admin/retention/purge-expired.",
    );
  }

  return url;
}

function bearerToken() {
  const tokenFile = trim(process.env.RETENTION_PURGE_TOKEN_FILE);
  const inlineToken = trim(process.env.RETENTION_PURGE_BEARER_TOKEN);

  if (tokenFile) {
    if (!existsSync(tokenFile)) {
      throw new Error(
        `RETENTION_PURGE_TOKEN_FILE does not exist: ${tokenFile}`,
      );
    }
    const token = readFileSync(tokenFile, "utf8").trim();
    if (!token) {
      throw new Error(`RETENTION_PURGE_TOKEN_FILE is empty: ${tokenFile}`);
    }
    return token;
  }

  if (inlineToken) {
    return inlineToken;
  }

  throw new Error("RETENTION_PURGE_TOKEN_FILE is required.");
}

function buildResult({
  endpoint,
  httpStatus,
  responseText,
  responsePayload,
  mode,
  startedAt,
  status,
}) {
  const completedAt = new Date();
  const responseHash = responseText
    ? createHash("sha256").update(responseText).digest("hex")
    : null;
  const candidateSchedule = extractCandidateSchedule(responsePayload);

  return {
    version: 1,
    status,
    mode,
    stage,
    dryRun: mode === "dry_run",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    endpoint: `${endpoint.origin}${endpoint.pathname}`,
    httpStatus,
    responseSha256: responseHash,
    responseKeys:
      responsePayload && typeof responsePayload === "object"
        ? Object.keys(responsePayload).sort()
        : [],
    candidateTenantCount:
      candidateSchedule.length ||
      numeric(responsePayload?.candidateTenantCount) ||
      numeric(responsePayload?.candidateCount),
    deletedRecordCount: deletedRecordCount(responsePayload),
    processedTenantCount:
      numeric(responsePayload?.processedTenantCount) ||
      firstArray(
        responsePayload?.purgedTenants,
        responsePayload?.applicationDataPurgedTenants,
      ).length,
    failedTenantCount:
      numeric(responsePayload?.failedTenantCount) ||
      firstArray(responsePayload?.failedTenants).length,
    skippedTenantCount:
      numeric(responsePayload?.skippedTenantCount) ||
      firstArray(responsePayload?.skippedTenants).length +
        firstArray(responsePayload?.blockedTenants).length,
    candidateSchedule,
    pendingDeletionBillingCandidates: firstArray(responsePayload?.pendingDeletionBillingCandidates),
    reconciledDeletionTenants: firstArray(responsePayload?.reconciledDeletionTenants),
    failedTenants: firstArray(responsePayload?.failedTenants),
    skippedTenants: [
      ...firstArray(responsePayload?.skippedTenants),
      ...firstArray(responsePayload?.blockedTenants),
    ],
    nextContinuation: validContinuation(responsePayload?.nextContinuation),
  };
}

function combinePageResults(results, maxPages, continuation = null) {
  const completedAt = new Date();
  const responseHashes = results
    .map((result) => result.responseSha256)
    .filter(Boolean);
  return {
    version: 1,
    status: results.every((result) => result.status === "ok") ? "ok" : "failed",
    mode,
    stage,
    dryRun: mode === "dry_run",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    endpoint:
      results[0]?.endpoint ?? trim(process.env.RETENTION_PURGE_URL) ?? null,
    httpStatus: results.at(-1)?.httpStatus ?? 0,
    responseSha256:
      responseHashes.length > 0
        ? createHash("sha256").update(responseHashes.join(":")).digest("hex")
        : null,
    responseKeys: Array.from(
      new Set(results.flatMap((result) => result.responseKeys)),
    ).sort(),
    pageCount: results.length,
    maxPages,
    continuationRemaining: Boolean(continuation),
    candidateTenantCount: results.reduce(
      (sum, result) => sum + result.candidateTenantCount,
      0,
    ),
    deletedRecordCount: results.reduce(
      (sum, result) => sum + result.deletedRecordCount,
      0,
    ),
    processedTenantCount: results.reduce(
      (sum, result) => sum + result.processedTenantCount,
      0,
    ),
    failedTenantCount: results.reduce(
      (sum, result) => sum + result.failedTenantCount,
      0,
    ),
    skippedTenantCount: results.reduce(
      (sum, result) => sum + result.skippedTenantCount,
      0,
    ),
    candidateSchedule: results.flatMap((result) => result.candidateSchedule),
    pendingDeletionBillingCandidates: results.flatMap((result) => result.pendingDeletionBillingCandidates),
    reconciledDeletionTenants: results.flatMap((result) => result.reconciledDeletionTenants),
    failedTenants: results.flatMap((result) => result.failedTenants),
    skippedTenants: results.flatMap((result) => result.skippedTenants),
  };
}

function failureResult(error) {
  const completedAt = new Date();
  return {
    version: 1,
    status: "failed",
    mode,
    stage,
    dryRun: mode === "dry_run",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    durationMs: completedAt.getTime() - startedAt.getTime(),
    endpoint: trim(process.env.RETENTION_PURGE_URL) || null,
    httpStatus: 0,
    responseSha256: null,
    responseKeys: [],
    candidateTenantCount: 0,
    deletedRecordCount: 0,
    processedTenantCount: 0,
    failedTenantCount: 0,
    skippedTenantCount: 0,
    candidateSchedule: [],
    pendingDeletionBillingCandidates: [],
    reconciledDeletionTenants: [],
    failedTenants: [],
    skippedTenants: [],
    error: String(error.message ?? error),
  };
}

function extractCandidateSchedule(payload) {
  const candidates = firstArray(
    payload?.candidates,
    payload?.candidateTenants,
    payload?.tenants,
  );
  return candidates
    .map((candidate) => ({
      tenantId: stringValue(candidate.tenantId ?? candidate.id),
      deletionRequestedAt: stringValue(
        candidate.deletionRequestedAt ??
          candidate.retention?.deletionRequestedAt ??
          candidate.deletedAt ??
          candidate.requestedAt,
      ),
      eligibleAt: stringValue(
        candidate.eligibleAt ??
          candidate.purgeEligibleAt ??
          candidate.fullDatabasePurgeEligibleAt ??
          candidate.applicationDataEligibleAt ??
          candidate.retention?.applicationDataEligibleAt ??
          candidate.retention?.fullDatabasePurgeEligibleAt ??
          candidate.retention?.retainedDatabaseRecordsEligibleAt,
      ),
    }))
    .filter(
      (candidate) =>
        candidate.tenantId ||
        candidate.deletionRequestedAt ||
        candidate.eligibleAt,
    );
}

function deletedRecordCount(payload) {
  for (const value of [
    payload?.deletedRecordCount,
    payload?.deletedCount,
    payload?.deletedRecords,
  ]) {
    const count = numeric(value);
    if (count > 0) return count;
  }

  const purgedTenantCount =
    sumRecordCountArray(payload?.purgedTenants) +
    sumRecordCountArray(payload?.applicationDataPurgedTenants);
  if (purgedTenantCount > 0) return purgedTenantCount;

  return (
    sumNumbers(payload?.deletedCounts) +
    sumNumbers(payload?.deletionCounts) +
    sumNumbers(payload?.deleted)
  );
}

function sumRecordCountArray(value) {
  if (!Array.isArray(value)) return 0;
  return value.reduce((sum, entry) => {
    if (!entry || typeof entry !== "object") return sum;
    return (
      sum +
      sumNumbers(entry.deletedRecordCounts) +
      sumNumbers(entry.deletedCounts) +
      sumNumbers(entry.deletionCounts)
    );
  }, 0);
}

function retentionStage(value) {
  const normalized = trim(value) || "retained_records";
  if (!["application_data", "retained_records"].includes(normalized)) {
    throw new Error(
      "RETENTION_PURGE_STAGE must equal application_data or retained_records.",
    );
  }
  return normalized;
}

function sumNumbers(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return 0;
  return Object.values(value).reduce((sum, entry) => sum + numeric(entry), 0);
}

function writeOutputs({ result, status, error }) {
  const proof = {
    ...result,
    status,
    error: error ? String(error.message ?? error) : undefined,
  };

  if (proofFile) {
    atomicWriteJson(proofFile, proof);
  }
  if (metricsFile) {
    atomicWrite(metricsFile, retentionMetrics(proof));
  }
}

function retentionMetrics(result) {
  const label = `{mode="${result.mode}"}`;
  const success = result.status === "ok" ? 1 : 0;
  const timestamp = Math.floor(Date.parse(result.completedAt) / 1000);
  const duration = Math.max(result.durationMs, 0) / 1000;

  return [
    "# HELP lunchlineup_retention_purge_last_attempt_timestamp_seconds Last retained-record purge invocation attempt time.",
    "# TYPE lunchlineup_retention_purge_last_attempt_timestamp_seconds gauge",
    `lunchlineup_retention_purge_last_attempt_timestamp_seconds${label} ${timestamp}`,
    "# HELP lunchlineup_retention_purge_last_success Whether the last retained-record purge invocation succeeded.",
    "# TYPE lunchlineup_retention_purge_last_success gauge",
    `lunchlineup_retention_purge_last_success${label} ${success}`,
    "# HELP lunchlineup_retention_purge_last_duration_seconds Duration of the last retained-record purge invocation.",
    "# TYPE lunchlineup_retention_purge_last_duration_seconds gauge",
    `lunchlineup_retention_purge_last_duration_seconds${label} ${duration.toFixed(3)}`,
    "# HELP lunchlineup_retention_purge_last_http_status HTTP status from the last retained-record purge invocation.",
    "# TYPE lunchlineup_retention_purge_last_http_status gauge",
    `lunchlineup_retention_purge_last_http_status${label} ${numeric(result.httpStatus)}`,
    "# HELP lunchlineup_retention_purge_last_candidate_tenants Candidate tenants from the last retained-record purge dry-run or execution.",
    "# TYPE lunchlineup_retention_purge_last_candidate_tenants gauge",
    `lunchlineup_retention_purge_last_candidate_tenants${label} ${numeric(result.candidateTenantCount)}`,
    "# HELP lunchlineup_retention_purge_last_deleted_records Deleted database records from the last retained-record purge execution.",
    "# TYPE lunchlineup_retention_purge_last_deleted_records gauge",
    `lunchlineup_retention_purge_last_deleted_records${label} ${numeric(result.deletedRecordCount)}`,
    "# HELP lunchlineup_retention_purge_last_processed_tenants Successfully processed tenants in the last bounded invocation.",
    "# TYPE lunchlineup_retention_purge_last_processed_tenants gauge",
    `lunchlineup_retention_purge_last_processed_tenants${label} ${numeric(result.processedTenantCount)}`,
    "# HELP lunchlineup_retention_purge_last_failed_tenants Failed tenant attempts in the last bounded invocation.",
    "# TYPE lunchlineup_retention_purge_last_failed_tenants gauge",
    `lunchlineup_retention_purge_last_failed_tenants${label} ${numeric(result.failedTenantCount)}`,
    "# HELP lunchlineup_retention_purge_last_skipped_tenants Skipped tenant attempts in the last bounded invocation.",
    "# TYPE lunchlineup_retention_purge_last_skipped_tenants gauge",
    `lunchlineup_retention_purge_last_skipped_tenants${label} ${numeric(result.skippedTenantCount)}`,
    "",
  ].join("\n");
}

function acquireLock(path) {
  ensureParent(path);
  try {
    const handle = openSync(path, "wx");
    writeFileSync(handle, `${process.pid}\n${new Date().toISOString()}\n`);
    return handle;
  } catch (error) {
    if (error.code === "EEXIST") {
      throw new Error(
        `Another retained-record purge invocation is already running: ${path}`,
      );
    }
    throw error;
  }
}

function releaseLock(handle, path) {
  if (handle === undefined) return;
  try {
    closeSync(handle);
  } finally {
    try {
      unlinkSync(path);
    } catch {
      // Best effort cleanup. A stale lock is safer than deleting an unknown path.
    }
  }
}

function atomicWriteJson(path, payload) {
  atomicWrite(path, `${JSON.stringify(payload, null, 2)}\n`);
}

function atomicWrite(path, contents) {
  ensureParent(path);
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, contents, "utf8");
  renameSync(temporary, path);
}

function ensureParent(path) {
  const parent = dirname(resolve(path));
  if (!isAbsolute(parent)) return;
  mkdirSync(parent, { recursive: true });
}

function parseJson(text) {
  if (!text.trim()) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function parseBoolean(value, fallback) {
  const normalized = trim(value).toLowerCase();
  if (!normalized) return fallback;
  if (["1", "true", "yes"].includes(normalized)) return true;
  if (["0", "false", "no"].includes(normalized)) return false;
  throw new Error(`Invalid boolean value: ${value}`);
}

function positiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : 0;
}

function firstArray(...values) {
  return values.find((value) => Array.isArray(value)) ?? [];
}

function validContinuation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const deletedAt = stringValue(value.deletedAt);
  const id = stringValue(value.id);
  return deletedAt && id ? { deletedAt, id } : null;
}

function stringValue(value) {
  return value === undefined || value === null ? undefined : String(value);
}

function trim(value) {
  return String(value ?? "").trim();
}

function isLoopbackHost(hostname) {
  return ["localhost", "127.0.0.1", "::1", "[::1]"].includes(
    hostname.toLowerCase(),
  );
}
