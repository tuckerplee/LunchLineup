#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

function fail(message) {
  console.error('ERROR: ' + message);
  process.exit(1);
}

function parseOptions(argv) {
  const options = new Map();
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith('--') || value === undefined || value.startsWith('--')) {
      fail('Arguments must be supplied as --name value pairs.');
    }
    if (options.has(key)) fail('Duplicate argument: ' + key);
    options.set(key, value);
  }
  return options;
}

function required(options, key) {
  const value = String(options.get(key) ?? '').trim();
  if (!value) fail(key + ' is required.');
  return value;
}

function positiveInteger(value, label) {
  if (!/^[1-9][0-9]*$/.test(value)) fail(label + ' must be a positive integer.');
  return Number(value);
}

function readJson(path, label) {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    fail(label + ' must contain valid JSON: ' + error.message);
  }
}

function stableJson(value) {
  if (Array.isArray(value)) {
    return '[' + value.map(stableJson).join(',') + ']';
  }
  if (value && typeof value === 'object') {
    return '{' + Object.keys(value).sort().map((key) => (
      JSON.stringify(key) + ':' + stableJson(value[key])
    )).join(',') + '}';
  }
  return JSON.stringify(value);
}

function ruleId(rule, index) {
  const id = String(rule?.ID ?? '').trim();
  if (!id) fail('Lifecycle rule ' + (index + 1) + ' must have a stable ID.');
  return id;
}

function normalizedConfiguration(configuration) {
  if (!configuration || typeof configuration !== 'object' || Array.isArray(configuration)) {
    fail('Live lifecycle policy must be a JSON object.');
  }
  if (!Array.isArray(configuration.Rules) || configuration.Rules.length === 0) {
    fail('Live lifecycle policy must contain at least one rule.');
  }

  const rules = configuration.Rules.map((rule, index) => {
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      fail('Lifecycle rule ' + (index + 1) + ' must be an object.');
    }
    return { rule, id: ruleId(rule, index) };
  });
  const ids = new Set();
  for (const { id } of rules) {
    if (ids.has(id)) fail('Lifecycle rule ID is duplicated: ' + id);
    ids.add(id);
  }

  return {
    ...configuration,
    Rules: rules
      .sort((left, right) => left.id.localeCompare(right.id))
      .map(({ rule }) => rule),
  };
}

function ruleScope(rule) {
  const filter = rule.Filter;
  if (rule.Tag || filter?.Tag || filter?.And?.Tags || filter?.And?.Tag) return null;
  if (filter?.And) {
    const extraAndFilters = Object.keys(filter.And).filter((key) => key !== 'Prefix');
    if (extraAndFilters.length > 0) return null;
  }
  if (filter) {
    const extraFilters = Object.keys(filter).filter((key) => !['And', 'Prefix'].includes(key));
    if (extraFilters.length > 0) return null;
  }
  if (typeof rule.Prefix === 'string') return rule.Prefix;
  if (typeof filter?.Prefix === 'string') return filter.Prefix;
  if (typeof filter?.And?.Prefix === 'string') return filter.And.Prefix;
  if (filter === undefined || (filter && Object.keys(filter).length === 0)) return '';
  return null;
}

function days(value, label) {
  if (!Number.isInteger(value) || value < 1) fail(label + ' must be a positive integer.');
  return value;
}

function inspectLifecycle(configuration, objectPrefix, immutableDays, maximumDays) {
  const enabled = configuration.Rules.filter((rule) => rule.Status === 'Enabled');
  if (enabled.length === 0) fail('Lifecycle policy has no enabled rules.');

  const applicable = enabled.filter((rule) => {
    const scope = ruleScope(rule);
    return scope !== null && objectPrefix.startsWith(scope);
  });
  const exact = applicable.filter((rule) => ruleScope(rule) === objectPrefix);
  if (exact.length === 0) {
    fail('Lifecycle policy has no enabled untagged rule scoped exactly to ' + objectPrefix);
  }

  for (const rule of applicable) {
    const id = String(rule.ID);
    for (const key of Object.keys(rule)) {
      if (/Expiration$/.test(key) && ![
        'Expiration',
        'NoncurrentVersionExpiration',
        'AbortIncompleteMultipartUpload',
      ].includes(key)) {
        fail('Lifecycle rule ' + id + ' uses unsupported expiration primitive ' + key + '.');
      }
    }
    if (rule.Expiration?.Date !== undefined) {
      fail('Lifecycle rule ' + id + ' uses one-time date expiration; recurring day bounds are required.');
    }
    if (rule.Expiration?.Days !== undefined) {
      const currentDays = days(rule.Expiration.Days, 'Lifecycle rule ' + id + ' current expiration');
      if (currentDays < immutableDays) {
        fail(
          'Lifecycle rule ' + id + ' expires current objects before the '
          + immutableDays + '-day immutable window.',
        );
      }
    }
  }

  const exactCurrent = exact.filter((rule) => rule.Expiration?.Days !== undefined);
  const exactNoncurrent = exact.filter((rule) => (
    rule.NoncurrentVersionExpiration?.NoncurrentDays !== undefined
    && Number(rule.NoncurrentVersionExpiration?.NewerNoncurrentVersions ?? 0) === 0
  ));
  const exactMarkerCleanup = exact.some((rule) => rule.Expiration?.ExpiredObjectDeleteMarker === true);

  if (exactCurrent.length === 0) {
    fail('Exact-prefix lifecycle rules must expire current versions after a bounded number of days.');
  }
  if (exactNoncurrent.length === 0) {
    fail(
      'Exact-prefix lifecycle rules must expire every noncurrent version '
      + 'without retaining newer versions indefinitely.',
    );
  }
  if (!exactMarkerCleanup) {
    fail('Exact-prefix lifecycle rules must remove expired delete markers.');
  }

  const applicableCurrentDays = applicable
    .filter((rule) => rule.Expiration?.Days !== undefined)
    .map((rule) => days(rule.Expiration.Days, 'Lifecycle rule ' + rule.ID + ' current expiration'));
  const applicableNoncurrentDays = applicable
    .filter((rule) => (
      rule.NoncurrentVersionExpiration?.NoncurrentDays !== undefined
      && Number(rule.NoncurrentVersionExpiration?.NewerNoncurrentVersions ?? 0) === 0
    ))
    .map((rule) => days(
      rule.NoncurrentVersionExpiration.NoncurrentDays,
      'Lifecycle rule ' + rule.ID + ' noncurrent expiration',
    ));

  const currentDays = Math.min(...applicableCurrentDays);
  const noncurrentDays = Math.min(...applicableNoncurrentDays);
  const configuredUpperBoundDays = currentDays + noncurrentDays;
  if (configuredUpperBoundDays > maximumDays) {
    fail(
      'Lifecycle current plus noncurrent expiration is ' + configuredUpperBoundDays
      + ' days, above PITR_LIFECYCLE_MAX_RETENTION_DAYS=' + maximumDays + '.',
    );
  }

  return {
    configuredUpperBoundDays,
    currentExpirationDays: currentDays,
    exactRuleCount: exact.length,
    noncurrentExpirationDays: noncurrentDays,
  };
}

const options = parseOptions(process.argv.slice(2));
const policyPath = required(options, '--policy-file');
const endpoint = required(options, '--endpoint');
const bucket = required(options, '--bucket');
const prefix = required(options, '--prefix');
const immutableDays = positiveInteger(required(options, '--immutable-days'), '--immutable-days');
const maximumDays = positiveInteger(required(options, '--maximum-days'), '--maximum-days');

let endpointUrl;
try {
  endpointUrl = new URL(endpoint);
} catch {
  fail('--endpoint must be a valid URL.');
}
if (endpointUrl.protocol !== 'https:') fail('--endpoint must use HTTPS.');
if (!/^[a-z0-9][a-z0-9.-]*[a-z0-9]$/.test(bucket)) fail('--bucket is invalid.');
if (
  prefix.startsWith('/')
  || prefix.endsWith('/')
  || prefix.includes('..')
  || !/^[A-Za-z0-9._/-]+$/.test(prefix)
) {
  fail('--prefix must be a dedicated cluster prefix without leading/trailing slash or traversal.');
}
if (immutableDays < 14) fail('--immutable-days must be at least 14.');
if (maximumDays <= immutableDays || maximumDays > 90) {
  fail('--maximum-days must be greater than immutable retention and no more than 90.');
}

const configuration = normalizedConfiguration(readJson(policyPath, 'Live lifecycle policy'));
const lifecycle = inspectLifecycle(
  configuration,
  prefix + '/',
  immutableDays,
  maximumDays,
);
const envelope = {
  bucket,
  endpoint: endpointUrl.href.replace(/\/$/, ''),
  immutableRetentionDays: immutableDays,
  lifecycleConfiguration: configuration,
  maximumRetentionDays: maximumDays,
  prefix,
  schemaVersion: 1,
};
const canonical = stableJson(envelope) + '\n';
const policySha256 = createHash('sha256').update(canonical).digest('hex');

const proofPath = String(options.get('--proof-file') ?? '').trim();
if (proofPath) {
  const proofCanonical = stableJson(readJson(proofPath, 'Retained lifecycle proof')) + '\n';
  if (proofCanonical !== canonical) {
    fail('Retained lifecycle proof does not match the live bucket policy and expected scope.');
  }
}

const expectedSha256 = String(options.get('--expected-sha256') ?? '').trim().toLowerCase();
if (expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256)) {
    fail('--expected-sha256 must be 64 lowercase hex characters.');
  }
  if (policySha256 !== expectedSha256) {
    fail('PITR_LIFECYCLE_POLICY_SHA256 does not match the live canonical lifecycle policy.');
  }
}

const canonicalOutput = String(options.get('--canonical-output') ?? '').trim();
if (canonicalOutput) {
  try {
    writeFileSync(canonicalOutput, canonical, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
  } catch (error) {
    fail('Cannot create canonical lifecycle proof: ' + error.message);
  }
}

console.log(
  'pitr_lifecycle_policy_ready'
  + ' current_expiration_days=' + lifecycle.currentExpirationDays
  + ' noncurrent_expiration_days=' + lifecycle.noncurrentExpirationDays
  + ' configured_upper_bound_days=' + lifecycle.configuredUpperBoundDays
  + ' maximum_retention_days=' + maximumDays
  + ' exact_rules=' + lifecycle.exactRuleCount
  + ' policy_sha256=' + policySha256,
);
