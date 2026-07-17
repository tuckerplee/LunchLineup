import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const PLACEHOLDER_RE = /(change_me|generate_with|replace_me|example|secret|password|guest)/i;

const LAUNCH_PROOF_PLACEHOLDER_RE =
  /<[^>]+>|YYYY|MMDD|HHMMSS|placeholder|todo|tbd|not_applicable|n\/a|dummy|fake|artifact-id|run-id/i;

export function createErrorCollector() {
  const errors = [];
  const checked = [];

  return {
    errors,
    checked,
    fail(message) {
      errors.push(message);
    },
    pass(name) {
      checked.push(name);
    },
  };
}

export function parseEnvFile(path, collector) {
  const absolute = resolve(path);
  if (!existsSync(absolute)) {
    throw new Error(`Environment file does not exist: ${path}`);
  }

  const parsed = {};
  const contents = readFileSync(absolute, 'utf8');

  for (const [index, rawLine] of contents.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;

    const normalized = line.startsWith('export ') ? line.slice(7).trim() : line;
    const separator = normalized.indexOf('=');
    if (separator === -1) {
      collector.fail(`Invalid env line ${index + 1}: expected KEY=value.`);
      continue;
    }

    const key = normalized.slice(0, separator).trim();
    let value = normalized.slice(separator + 1).trim();
    if (!/^[A-Z0-9_]+$/.test(key)) {
      collector.fail(`Invalid env key on line ${index + 1}: ${key}`);
      continue;
    }

    if (
      (value.startsWith('"') && value.endsWith('"'))
      || (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    parsed[key] = value;
  }

  return parsed;
}

export function createPolicyContext(env, collector) {
  function readCsv(value) {
    return String(value ?? '')
      .split(',')
      .map((entry) => entry.trim())
      .filter(Boolean);
  }

  function stripPort(host) {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    if (normalized.startsWith('[')) {
      return normalized.slice(1, normalized.indexOf(']'));
    }
    return normalized.split(':')[0];
  }

  function normalizeHost(value, key) {
    const raw = String(value ?? '').trim();
    if (!raw || raw.includes('://') || raw.includes('/') || raw.includes('\\') || raw.includes('@') || raw.includes('*')) {
      collector.fail(`${key} must be a hostname, not a URL, wildcard, or path.`);
      return null;
    }

    try {
      return new URL(`http://${raw}`).hostname.toLowerCase().replace(/\.$/, '');
    } catch {
      collector.fail(`${key} must be a valid hostname.`);
      return null;
    }
  }

  function isReservedHostname(host) {
    const normalized = host.toLowerCase().replace(/\.$/, '');
    return (
      normalized === 'localhost'
      || normalized.endsWith('.localhost')
      || normalized === 'example'
      || normalized.endsWith('.example')
      || normalized === 'example.com'
      || normalized === 'example.net'
      || normalized === 'example.org'
      || normalized.endsWith('.example.com')
      || normalized.endsWith('.example.net')
      || normalized.endsWith('.example.org')
      || normalized === 'test'
      || normalized.endsWith('.test')
      || normalized === 'invalid'
      || normalized.endsWith('.invalid')
    );
  }

  function isPrivateIp(host) {
    const parts = host.split('.').map((part) => Number.parseInt(part, 10));
    if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) {
      return false;
    }

    const [a, b] = parts;
    return (
      a === 0
      || a === 10
      || a === 127
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
    );
  }

  function isPublicLaunchHostname(host) {
    return Boolean(host && host.includes('.') && !isReservedHostname(host) && !isPrivateIp(host));
  }

  function assertPublicHost(key) {
    const host = normalizeHost(env[key], key);
    if (!host) return null;

    if (!isPublicLaunchHostname(host)) {
      collector.fail(`${key} must be a real public hostname, not localhost, private IP, .test, or example domain.`);
      return null;
    }

    collector.pass(key);
    return host;
  }

  function assertHttpsUrl(key, value, { requirePublicHost = true } = {}) {
    const raw = String(value ?? '').trim();
    try {
      const url = new URL(raw);
      if (url.protocol !== 'https:') {
        collector.fail(`${key} must use https: ${raw}`);
        return null;
      }
      if (requirePublicHost && !isPublicLaunchHostname(url.hostname)) {
        collector.fail(`${key} must use a real public hostname: ${raw}`);
        return null;
      }
      return url;
    } catch {
      collector.fail(`${key} must be a valid https URL: ${raw}`);
      return null;
    }
  }

  function assertHttpsOrigin(key, value) {
    const url = assertHttpsUrl(key, value);
    if (!url) return null;
    if (url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      collector.fail(`${key} must contain only a public HTTPS origin.`);
      return null;
    }
    collector.pass(key);
    return url.origin;
  }

  function readBooleanFlag(key, defaultValue = 'false') {
    const value = String(env[key] ?? defaultValue).trim().toLowerCase();
    if (!['true', 'false'].includes(value)) {
      collector.fail(`${key} must be true or false for public launch.`);
      return null;
    }
    collector.pass(key);
    return value === 'true';
  }

  function assertRequired(key) {
    const value = String(env[key] ?? '').trim();
    if (!value) {
      collector.fail(`${key} is required for public launch.`);
      return '';
    }
    collector.pass(key);
    return value;
  }

  function assertExactValue(key, expected) {
    const value = assertRequired(key);
    if (!value) return null;
    if (value !== expected) {
      collector.fail(`${key} must be exactly ${expected}.`);
      return null;
    }
    collector.pass(key);
    return value;
  }

  function assertSecret(key, minLength = 32) {
    const value = assertRequired(key);
    if (!value) return;
    if (value.length < minLength || PLACEHOLDER_RE.test(value)) {
      collector.fail(`${key} must be a non-placeholder value with at least ${minLength} characters.`);
    }
  }

  function assertPattern(key, pattern, description) {
    const value = assertRequired(key);
    if (!value) return;
    if (!pattern.test(value)) {
      collector.fail(`${key} must ${description}.`);
    }
  }

  function assertPublicContactEmail(key) {
    const value = assertRequired(key);
    if (!value) return;

    const match = value.match(/^[^\s@<>]+@([^\s@<>]+\.[^\s@<>]+)$/);
    const host = match?.[1]?.toLowerCase();
    if (!host) {
      collector.fail(`${key} must be a bare email address for a monitored public mailbox.`);
      return;
    }

    if (!isPublicLaunchHostname(host)) {
      collector.fail(`${key} must use a real public mailbox domain, not localhost, private IP, .test, .invalid, .example, or example domains.`);
    }
  }

  function hasPlaceholderProofReference(value) {
    return PLACEHOLDER_RE.test(value) || LAUNCH_PROOF_PLACEHOLDER_RE.test(value);
  }

  function isVagueProofReference(value) {
    return /(^|[/:_-])(latest|current)([/:_.-]|$)/i.test(value);
  }

  function assertProofArtifactUri(key, { requireJson = false, httpsOnly = false } = {}) {
    const value = assertRequired(key);
    if (!value) return;

    if (hasPlaceholderProofReference(value)) {
      collector.fail(`${key} must not contain placeholder text.`);
      return;
    }

    if (isVagueProofReference(value)) {
      collector.fail(`${key} must reference a specific retained proof artifact, not latest/current.`);
      return;
    }

    if (requireJson && !/\.json(?:[?#].*)?$/i.test(value)) {
      collector.fail(`${key} must reference the retained JSON proof file.`);
      return;
    }

    if (/^https:\/\//i.test(value)) {
      if (assertHttpsUrl(key, value)) collector.pass(key);
      return;
    }

    if (!httpsOnly && /^(s3:\/\/[^ ]+|rclone:[^ ]+)$/i.test(value)) {
      collector.pass(key);
      return;
    }

    if (httpsOnly) {
      collector.fail(`${key} must use a retained HTTPS proof URI that the deployment host can download directly.`);
    } else {
      collector.fail(`${key} must use a retained proof URI: https://..., s3://..., or rclone:<remote:path>.`);
    }
  }

  return {
    env,
    collector,
    readCsv,
    stripPort,
    normalizeHost,
    isPrivateIp,
    isPublicLaunchHostname,
    assertPublicHost,
    assertHttpsUrl,
    assertHttpsOrigin,
    readBooleanFlag,
    assertRequired,
    assertExactValue,
    assertSecret,
    assertPattern,
    assertPublicContactEmail,
    hasPlaceholderProofReference,
    isVagueProofReference,
    assertProofArtifactUri,
  };
}
