#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

function fail(message) {
  console.error(`ERROR: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined) fail('Arguments must be --name value pairs.');
    values.set(key.slice(2), value);
  }
  return values;
}

function readJson(path, label) {
  try {
    return { bytes: readFileSync(path), value: JSON.parse(readFileSync(path, 'utf8')) };
  } catch {
    fail(`${label} must be valid JSON.`);
  }
}

const args = parseArgs(process.argv.slice(2));
const requestPath = args.get('request-file');
const responsePath = args.get('response-file');
const simulatorSha256 = args.get('simulator-sha256');
const maximumAgeSeconds = Number(args.get('maximum-age-seconds') ?? '120');
if (!requestPath || !responsePath) fail('request-file and response-file are required.');
if (!/^[a-f0-9]{64}$/.test(simulatorSha256 ?? '')) fail('simulator-sha256 must be lowercase SHA-256.');
if (!Number.isInteger(maximumAgeSeconds) || maximumAgeSeconds < 1 || maximumAgeSeconds > 300) {
  fail('maximum-age-seconds must be an integer from 1 through 300.');
}

const requestDocument = readJson(requestPath, 'Authorization simulation request');
const responseDocument = readJson(responsePath, 'Authorization simulation response');
const request = requestDocument.value;
const response = responseDocument.value;
const requestSha256 = createHash('sha256').update(requestDocument.bytes).digest('hex');
const safeToken = (value, minimum = 3, maximum = 512) => (
  typeof value === 'string'
  && value.length >= minimum
  && value.length <= maximum
  && /^[\x21-\x7e]+$/.test(value)
);
const allowedActions = request?.requiredAllowedActions;
const deniedActions = request?.requiredDeniedActions;
if (
  request?.version !== 1
  || request?.kind !== 'lunchlineup-pitr-provider-authorization-request'
  || !['restore', 'lifecycle-audit'].includes(request?.role)
  || !safeToken(request?.requestId, 16, 128)
  || !Array.isArray(allowedActions)
  || allowedActions.length === 0
  || !Array.isArray(deniedActions)
  || deniedActions.length === 0
  || !allowedActions.every((action) => /^s3:[A-Za-z]+$/.test(action))
  || !deniedActions.every((action) => /^s3:[A-Za-z]+$/.test(action))
  || new Set([...allowedActions, ...deniedActions]).size !== allowedActions.length + deniedActions.length
) fail('Authorization simulation request contract is invalid.');

const simulatedAt = Date.parse(response?.simulatedAt);
const ageMilliseconds = Date.now() - simulatedAt;
if (
  response?.version !== 1
  || response?.kind !== 'lunchlineup-pitr-provider-authorization-result'
  || response?.source !== 'provider-authorization-api'
  || response?.requestId !== request.requestId
  || response?.requestSha256 !== requestSha256
  || response?.role !== request.role
  || response?.scope?.endpoint !== request.scope?.endpoint
  || response?.scope?.bucket !== request.scope?.bucket
  || response?.scope?.prefix !== request.scope?.prefix
  || !safeToken(response?.principal)
  || !safeToken(response?.providerRequestId, 8, 256)
  || !Number.isFinite(simulatedAt)
  || ageMilliseconds < -30_000
  || ageMilliseconds > maximumAgeSeconds * 1000
  || !response?.decisions
  || typeof response.decisions !== 'object'
  || Array.isArray(response.decisions)
) fail('Provider authorization simulation result is stale, unauthenticated, or not bound to this request.');

const expectedActions = [...allowedActions, ...deniedActions].sort();
const actualActions = Object.keys(response.decisions).sort();
if (JSON.stringify(expectedActions) !== JSON.stringify(actualActions)) {
  fail('Provider authorization simulation must return exactly every requested action decision.');
}
for (const action of allowedActions) {
  if (response.decisions[action] !== 'allowed') {
    fail(`${request.role} identity is missing required ${action} authorization.`);
  }
}
for (const action of deniedActions) {
  if (response.decisions[action] !== 'denied') {
    fail(`${request.role} identity is overprivileged for ${action}; explicit denied authorization is required.`);
  }
}

console.log(
  `pitr_authorization_simulation_ready role=${request.role}`
  + ` principal=${response.principal}`
  + ` provider_request_id=${response.providerRequestId}`
  + ` denied_mutations=${deniedActions.length}`
  + ` simulator_sha256=${simulatorSha256}`,
);
