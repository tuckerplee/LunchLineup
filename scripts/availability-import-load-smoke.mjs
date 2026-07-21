import { createHash, randomUUID } from "node:crypto";
import { readFile, stat, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_PDF_BYTES = 5 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 64 * 1024;
const CREDIT_SOURCE_ATTESTATIONS = new Set(["stripe-credit-purchase", "admin-credit-grant"]);
const STAFF_IDENTITY_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;
const TERMINAL_STATUSES = new Set(["SUCCEEDED", "FAILED", "DEAD_LETTERED", "CANCELLED"]);

export function boundedInteger(name, raw, fallback, minimum, maximum) {
  const value = raw === undefined || raw === "" ? fallback : Number(raw);
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new Error(name + " must be an integer from " + minimum + " through " + maximum + ".");
  }
  return value;
}

export function validateLoadTarget(raw, allowLocal = false) {
  const target = new URL(raw);
  if (target.username || target.password || target.search || target.hash) {
    throw new Error("TARGET_URL must not contain credentials, a query, or a fragment.");
  }
  const local = target.hostname === "127.0.0.1" || target.hostname === "localhost" || target.hostname === "::1";
  if (target.protocol !== "https:" && !(allowLocal && local && target.protocol === "http:")) {
    throw new Error("TARGET_URL must use HTTPS unless ALLOW_LOCAL_LOAD_SMOKE=true targets loopback.");
  }
  target.pathname = target.pathname.replace(/\/+$/, "");
  return target;
}

export function validateRequestOrigin(raw) {
  const origin = new URL(String(raw || ""));
  const loopback = ["127.0.0.1", "localhost", "::1"].includes(origin.hostname);
  if (origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash
    || (origin.protocol !== "https:" && !(loopback && origin.protocol === "http:"))) {
    throw new Error("AVAILABILITY_IMPORT_ORIGIN must be a clean HTTPS origin (or HTTP loopback origin).");
  }
  return origin.origin;
}

export function isTerminalAvailabilityStatus(status) {
  return TERMINAL_STATUSES.has(String(status || "").toUpperCase());
}
export function validateCreditSourceAttestation(raw) {
  const value = String(raw || "").trim();
  if (!CREDIT_SOURCE_ATTESTATIONS.has(value)) {
    throw new Error("AVAILABILITY_IMPORT_CREDIT_SOURCE_ATTESTATION must be exactly stripe-credit-purchase or admin-credit-grant.");
  }
  return value;
}

export function createDeterministicAvailabilityPdf(staffIdentifier) {
  const identity = String(staffIdentifier || "").trim();
  if (!STAFF_IDENTITY_PATTERN.test(identity)) {
    throw new Error("The resolved target user does not have a PDF-safe staff identifier.");
  }
  const stream = [
    "BT",
    "/F1 12 Tf",
    "72 720 Td",
    `(Employee ID: ${identity}) Tj`,
    "0 -18 Td",
    "(Monday: 9:00 AM - 5:00 PM) Tj",
    "ET",
    "",
  ].join("\n");
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>",
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    `<< /Length ${Buffer.byteLength(stream, "ascii")} >>\nstream\n${stream}endstream`,
  ];
  let document = "%PDF-1.4\n";
  const offsets = [0];
  for (let index = 0; index < objects.length; index += 1) {
    offsets.push(Buffer.byteLength(document, "ascii"));
    document += `${index + 1} 0 obj\n${objects[index]}\nendobj\n`;
  }
  const xrefOffset = Buffer.byteLength(document, "ascii");
  document += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  document += offsets.slice(1).map((offset) => String(offset).padStart(10, "0") + " 00000 n \n").join("");
  document += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(document, "ascii");
}

export function buildEntitlementEvidence(matrix, requestCount, creditSourceAttestation, verifiedAt = new Date()) {
  const scheduling = matrix?.features?.scheduling;
  if (matrix?.status !== "ACTIVE" || matrix.stripeSubscriptionPresent !== true || matrix.stripeSubscriptionActive !== true) {
    throw new Error("Availability-import load smoke requires an ACTIVE paid Stripe subscription.");
  }
  if (scheduling?.enabled !== true || scheduling.source !== "credits"
    || !Number.isSafeInteger(scheduling.creditCost) || scheduling.creditCost <= 0) {
    throw new Error("Scheduling must be enabled by paid subscription plus positive-cost wallet credits.");
  }
  const requiredCredits = requestCount * scheduling.creditCost;
  if (!Number.isSafeInteger(matrix.usageCredits) || matrix.usageCredits < requiredCredits) {
    throw new Error(`Availability-import load smoke requires ${requiredCredits} wallet credits but billing reported ${matrix.usageCredits}.`);
  }
  return {
    evidenceType: "availability-import-entitlement",
    status: "passed",
    verifiedAt: verifiedAt.toISOString(),
    endpoint: "/api/v2/billing/features",
    tenantStatus: matrix.status,
    paidStripeSubscriptionVerified: true,
    stripeSubscriptionPresent: matrix.stripeSubscriptionPresent,
    stripeSubscriptionActive: matrix.stripeSubscriptionActive,
    featureSource: scheduling.source,
    creditSourceAttestation,
    creditCostPerImport: scheduling.creditCost,
    requestCount,
    requiredCredits,
    availableCredits: matrix.usageCredits,
  };
}

function requiredEnvironment(name) {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new Error(name + " is required.");
  }
  return value;
}

function responseData(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("Availability import API returned an invalid JSON object.");
  }
  const data = payload.data;
  return data && typeof data === "object" && !Array.isArray(data) ? data : payload;
}

async function requestJson(url, options, expectedStatus) {
  const response = await fetch(url, {
    ...options,
    signal: AbortSignal.timeout(15_000),
  });
  const text = await response.text();
  if (text.length > MAX_RESPONSE_BYTES) {
    throw new Error("Availability import API response exceeded the bounded size.");
  }
  if (response.status !== expectedStatus) {
    throw new Error("Availability import API returned HTTP " + response.status + ".");
  }
  try {
    return responseData(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new Error("Availability import API returned invalid JSON.");
    }
    throw error;
  }
}

export function cookieAuthFromSetCookieHeaders(headers) {
  const cookies = new Map();
  for (const header of headers) {
    const pair = String(header).split(";", 1)[0];
    const separator = pair.indexOf("=");
    if (separator > 0) cookies.set(pair.slice(0, separator), pair.slice(separator + 1));
  }
  if (!cookies.get("access_token") || !cookies.get("csrf_token")) {
    throw new Error("PIN login did not issue the required access and CSRF cookies.");
  }
  return {
    mode: "cookie",
    cookie: Array.from(cookies, ([name, value]) => `${name}=${value}`).join("; "),
    csrfToken: decodeURIComponent(cookies.get("csrf_token")),
  };
}

async function authenticate(apiBase) {
  const bearerToken = process.env.AVAILABILITY_IMPORT_BEARER_TOKEN?.trim();
  const tenantSlug = process.env.AVAILABILITY_IMPORT_TENANT_SLUG?.trim();
  const identifier = process.env.AVAILABILITY_IMPORT_LOGIN_IDENTIFIER?.trim();
  const pin = process.env.AVAILABILITY_IMPORT_LOGIN_PIN?.trim();
  const suppliedCookieFields = [tenantSlug, identifier, pin].filter(Boolean).length;
  if (bearerToken && suppliedCookieFields) throw new Error("Configure bearer or cookie auth, not both.");
  if (suppliedCookieFields && suppliedCookieFields !== 3) {
    throw new Error("Tenant slug, login identifier, and PIN are all required for cookie auth.");
  }
  const requestOrigin = suppliedCookieFields === 3
    ? validateRequestOrigin(requiredEnvironment("AVAILABILITY_IMPORT_ORIGIN"))
    : null;
  if (suppliedCookieFields === 3) {
    const response = await fetch(apiBase + "/auth/pin/verify", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: requestOrigin },
      body: JSON.stringify({ tenantSlug, identifier, pin }),
      signal: AbortSignal.timeout(15_000),
    });
    const text = await response.text();
    if (response.status !== 200 || Buffer.byteLength(text) > MAX_RESPONSE_BYTES) {
      throw new Error("PIN login failed with HTTP " + response.status + ".");
    }
    const login = responseData(JSON.parse(text));
    if (login.success !== true || login.requiresMfa === true || login.pinResetRequired === true) {
      throw new Error("PIN login did not establish a load-smoke-ready session.");
    }
    const setCookies = typeof response.headers.getSetCookie === "function"
      ? response.headers.getSetCookie()
      : [response.headers.get("set-cookie")].filter(Boolean);
    return { ...cookieAuthFromSetCookieHeaders(setCookies), origin: requestOrigin };
  }
  if (bearerToken) return { mode: "bearer", bearerToken };
  throw new Error("Cookie auth credentials or AVAILABILITY_IMPORT_BEARER_TOKEN are required.");
}

function authHeaders(auth, mutating = false) {
  if (auth.mode === "bearer") return { Authorization: "Bearer " + auth.bearerToken };
  return {
    Cookie: auth.cookie,
    ...(mutating ? { Origin: auth.origin, "X-CSRF-Token": auth.csrfToken } : {}),
  };
}

async function resolveTargetUser(apiBase, auth, targetIdentifier) {
  const directory = await requestJson(apiBase + "/users?limit=200", { headers: authHeaders(auth) }, 200);
  if (!Array.isArray(directory.data)) throw new Error("User directory returned invalid data.");
  const expected = targetIdentifier.trim().toLowerCase();
  const matches = directory.data.filter((user) => [user.id, user.username, user.email]
    .filter((value) => typeof value === "string")
    .some((value) => value.trim().toLowerCase() === expected));
  if (matches.length !== 1) throw new Error("Availability-import target user must resolve exactly once.");
  const user = matches[0];
  if (!["MANAGER", "STAFF"].includes(user.role)) throw new Error("Availability-import target must be manager or staff.");
  const pdfIdentity = STAFF_IDENTITY_PATTERN.test(user.username?.trim() || "") ? user.username.trim() : user.id;
  if (!STAFF_IDENTITY_PATTERN.test(pdfIdentity)) throw new Error("Target user has no valid PDF identity.");
  return { id: user.id, pdfIdentity };
}

async function submitAndWait({
  apiBase,
  auth,
  pdfBytes,
  sequence,
  timeoutMs,
  pollIntervalMs,
  userId,
}) {
  const form = new FormData();
  form.append("file", new Blob([pdfBytes], { type: "application/pdf" }), "availability-load-smoke.pdf");
  const idempotencyKey = "availability-load-smoke-" + Date.now() + "-" + sequence + "-" + randomUUID();
  const created = await requestJson(
    apiBase + "/availability-imports/users/" + encodeURIComponent(userId),
    {
      method: "POST",
      headers: {
        ...authHeaders(auth, true),
        "Idempotency-Key": idempotencyKey,
      },
      body: form,
    },
    202,
  );
  const importId = String(created.id || "");
  if (!importId || importId.length > 128) {
    throw new Error("Availability import API did not return a bounded import ID.");
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const current = await requestJson(
      apiBase + "/availability-imports/" + encodeURIComponent(importId),
      { headers: authHeaders(auth) },
      200,
    );
    const status = String(current.status || "").toUpperCase();
    if (isTerminalAvailabilityStatus(status)) {
      if (status !== "SUCCEEDED") {
        throw new Error("Availability import reached terminal status " + status + ".");
      }
      return { importId, status };
    }
    await new Promise((complete) => setTimeout(complete, pollIntervalMs));
  }
  throw new Error("Availability import did not reach a terminal state before the bounded timeout.");
}

export async function runAvailabilityImportLoadSmoke() {
  const creditSourceAttestation = validateCreditSourceAttestation(
    requiredEnvironment("AVAILABILITY_IMPORT_CREDIT_SOURCE_ATTESTATION"),
  );
  const target = validateLoadTarget(
    requiredEnvironment("TARGET_URL"),
    process.env.ALLOW_LOCAL_LOAD_SMOKE === "true",
  );
  const requestCount = boundedInteger(
    "AVAILABILITY_IMPORT_REQUESTS",
    process.env.AVAILABILITY_IMPORT_REQUESTS,
    4,
    2,
    12,
  );
  const concurrency = boundedInteger(
    "AVAILABILITY_IMPORT_CONCURRENCY",
    process.env.AVAILABILITY_IMPORT_CONCURRENCY,
    2,
    2,
    4,
  );
  if (concurrency > requestCount) {
    throw new Error("AVAILABILITY_IMPORT_CONCURRENCY cannot exceed AVAILABILITY_IMPORT_REQUESTS.");
  }
  const timeoutSeconds = boundedInteger(
    "AVAILABILITY_IMPORT_TIMEOUT_SECONDS",
    process.env.AVAILABILITY_IMPORT_TIMEOUT_SECONDS,
    180,
    30,
    300,
  );
  const pollIntervalMs = boundedInteger(
    "AVAILABILITY_IMPORT_POLL_INTERVAL_MS",
    process.env.AVAILABILITY_IMPORT_POLL_INTERVAL_MS,
    1000,
    500,
    5000,
  );

  const basePath = target.pathname === "/" ? "" : target.pathname;
  const apiBase = target.origin + basePath + "/api/v2";
  const auth = await authenticate(apiBase);
  const targetUser = await resolveTargetUser(
    apiBase,
    auth,
    requiredEnvironment("AVAILABILITY_IMPORT_TARGET_USER_IDENTIFIER"),
  );
  const billingFeatures = await requestJson(
    apiBase + "/billing/features",
    { headers: authHeaders(auth) },
    200,
  );
  const entitlementEvidence = buildEntitlementEvidence(
    billingFeatures,
    requestCount,
    creditSourceAttestation,
  );
  const entitlementEvidencePath = process.env.AVAILABILITY_IMPORT_ENTITLEMENT_EVIDENCE_PATH?.trim();
  const evidencePath = process.env.AVAILABILITY_IMPORT_EVIDENCE_PATH?.trim();
  if (entitlementEvidencePath && evidencePath && resolve(entitlementEvidencePath) === resolve(evidencePath)) {
    throw new Error("Load and entitlement evidence paths must be different.");
  }
  if (entitlementEvidencePath) {
    await writeFile(resolve(entitlementEvidencePath), JSON.stringify(entitlementEvidence, null, 2) + "\n", { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(entitlementEvidence) + "\n");

  const suppliedPdfPath = process.env.AVAILABILITY_IMPORT_PDF_PATH?.trim();
  let pdfBytes;
  let sourcePdfMode;
  if (suppliedPdfPath) {
    const pdfPath = resolve(suppliedPdfPath);
    const metadata = await stat(pdfPath);
    if (!metadata.isFile() || metadata.size <= 5 || metadata.size > MAX_PDF_BYTES) {
      throw new Error("AVAILABILITY_IMPORT_PDF_PATH must be a regular PDF no larger than 5 MiB.");
    }
    pdfBytes = await readFile(pdfPath);
    sourcePdfMode = "provided";
  } else {
    pdfBytes = createDeterministicAvailabilityPdf(targetUser.pdfIdentity);
    sourcePdfMode = "generated";
  }
  if (!pdfBytes.subarray(0, 5).equals(Buffer.from("%PDF-"))) {
    throw new Error("Availability import source does not have a PDF signature.");
  }

  const startedAt = new Date();
  const results = new Array(requestCount);
  let nextSequence = 0;
  let stopped = false;
  const runners = Array.from({ length: concurrency }, async () => {
    while (!stopped) {
      const sequence = nextSequence;
      nextSequence += 1;
      if (sequence >= requestCount) return;
      try {
        results[sequence] = await submitAndWait({
          apiBase,
          auth,
          pdfBytes,
          sequence,
          timeoutMs: timeoutSeconds * 1000,
          pollIntervalMs,
          userId: targetUser.id,
        });
      } catch (error) {
        stopped = true;
        throw error;
      }
    }
  });
  await Promise.all(runners);

  const completedAt = new Date();
  const evidence = {
    evidenceType: "availability-import-load",
    status: "passed",
    startedAt: startedAt.toISOString(),
    completedAt: completedAt.toISOString(),
    elapsedMs: completedAt.getTime() - startedAt.getTime(),
    requestCount,
    maxConcurrency: concurrency,
    succeeded: results.filter((result) => result?.status === "SUCCEEDED").length,
    parserConcurrencyPolicy: "single-parser-serialized",
    targetResolution: "tenant-user-directory",
    sourcePdfMode,
    sourcePdfSha256: createHash("sha256").update(pdfBytes).digest("hex"),
    entitlementEvidenceSha256: createHash("sha256")
      .update(JSON.stringify(entitlementEvidence), "utf8")
      .digest("hex"),
  };
  if (evidencePath) {
    await writeFile(resolve(evidencePath), JSON.stringify(evidence, null, 2) + "\n", { mode: 0o600 });
  }
  process.stdout.write(JSON.stringify(evidence) + "\n");
  return evidence;
}

const invokedPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedPath === fileURLToPath(import.meta.url)) {
  runAvailabilityImportLoadSmoke().catch((error) => {
    process.stderr.write("availability_import_load_smoke_failed reason=" + error.message + "\n");
    process.exitCode = 1;
  });
}
