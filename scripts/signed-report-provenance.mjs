import { readFileSync, statSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';

export const REPORT_SIGNATURE_SCHEME = 'sigstore-keyless-cosign-v1';
export const REPORT_ATTESTATION_TYPE = 'custom';
export const REPORT_PREDICATE_TYPE = 'https://cosign.sigstore.dev/attestation/v1';

function requireSingleLine(value, label) {
  if (typeof value !== 'string' || value.length === 0 || /[\r\n]/.test(value)) {
    throw new Error(`${label} must be a non-empty single-line string.`);
  }
  return value;
}

function requireSigner(certificateIdentity, oidcIssuer) {
  const identity = requireSingleLine(certificateIdentity, 'expected certificate identity');
  const issuer = requireSingleLine(oidcIssuer, 'expected OIDC issuer');
  if (!identity.startsWith('https://github.com/') || !identity.includes('/.github/workflows/')) {
    throw new Error('Expected certificate identity must name a GitHub Actions workflow URL.');
  }
  if (new URL(issuer).protocol !== 'https:') {
    throw new Error('Expected OIDC issuer must use HTTPS.');
  }
  return { identity, issuer };
}

function parseJsonObject(path, label) {
  let value;
  try {
    value = JSON.parse(readFileSync(resolve(path), 'utf8'));
  } catch (error) {
    throw new Error(`${label} must contain JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must contain a JSON object.`);
  }
  return value;
}

function cosignInvocation() {
  const command = process.env.COSIGN_BINARY || 'cosign';
  let prefix = [];
  if (process.env.COSIGN_ARGUMENT_PREFIX_JSON) {
    try {
      prefix = JSON.parse(process.env.COSIGN_ARGUMENT_PREFIX_JSON);
    } catch {
      throw new Error('COSIGN_ARGUMENT_PREFIX_JSON must be a JSON array.');
    }
    if (!Array.isArray(prefix) || prefix.some((value) => typeof value !== 'string' || /[\r\n]/.test(value))) {
      throw new Error('COSIGN_ARGUMENT_PREFIX_JSON must contain only single-line strings.');
    }
  }
  return { command, prefix };
}

function runCosign(args, label) {
  const { command, prefix } = cosignInvocation();
  const result = spawnSync(command, [...prefix, ...args], {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  if (result.error) {
    throw new Error(`Cosign is required for ${label} and could not be executed: ${result.error.message}`);
  }
  if (result.status !== 0) {
    const detail = String(result.stderr || result.stdout || '').trim().slice(0, 800);
    throw new Error(`Cosign rejected ${label}${detail ? `: ${detail}` : '.'}`);
  }
  return String(result.stdout || '').trim();
}

function parseAttestations(output) {
  if (!output) throw new Error('Cosign returned no registry attestation payloads.');
  try {
    const parsed = JSON.parse(output);
    return Array.isArray(parsed) ? parsed : [parsed];
  } catch {
    const values = [];
    for (const line of output.split(/\r?\n/).filter(Boolean)) {
      try {
        values.push(JSON.parse(line));
      } catch {
        throw new Error('Cosign registry attestation output was not valid JSON.');
      }
    }
    return values;
  }
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function statementFromAttestation(attestation) {
  if (typeof attestation?.payload !== 'string' || attestation.payload.length === 0) return null;
  try {
    const statement = JSON.parse(Buffer.from(attestation.payload, 'base64').toString('utf8'));
    return statement && typeof statement === 'object' && !Array.isArray(statement) ? statement : null;
  } catch {
    return null;
  }
}

function imageIdentity(imageRef) {
  const match = /^(?<name>[^@]+)@sha256:(?<digest>[a-f0-9]{64})$/i.exec(imageRef);
  if (!match?.groups) throw new Error('Release report image ref must be digest-pinned.');
  const taggedName = match.groups.name;
  const repository = taggedName.replace(/:[^/:]+$/, '');
  return { taggedName, repository, digest: match.groups.digest.toLowerCase() };
}

function statementMatches(statement, evidence, image) {
  if (!String(statement?._type ?? '').startsWith('https://in-toto.io/Statement/')) return false;
  if (statement.predicateType !== REPORT_PREDICATE_TYPE) return false;
  if (canonicalJson(statement.predicate) !== canonicalJson(evidence)) return false;
  if (!Array.isArray(statement.subject)) return false;
  return statement.subject.some((subject) => (
    (subject?.name === image.repository || subject?.name === image.taggedName)
    && String(subject?.digest?.sha256 ?? '').toLowerCase() === image.digest
  ));
}

export function signedReportPolicy(certificateIdentity, oidcIssuer, registryAttestationRequired = true) {
  const { identity, issuer } = requireSigner(certificateIdentity, oidcIssuer);
  if (typeof registryAttestationRequired !== 'boolean') {
    throw new Error('Registry attestation policy must be boolean.');
  }
  return {
    scheme: REPORT_SIGNATURE_SCHEME,
    attestationType: REPORT_ATTESTATION_TYPE,
    predicateType: REPORT_PREDICATE_TYPE,
    registryAttestationRequired,
    certificateIdentity: identity,
    oidcIssuer: issuer,
  };
}

export function verifySignedReportProvenance({
  evidencePath,
  signatureBundlePath,
  imageRef,
  certificateIdentity,
  oidcIssuer,
  registryAttestationRequired = true,
}) {
  const evidence = parseJsonObject(evidencePath, 'Release report evidence');
  const signatureBundle = resolve(signatureBundlePath);
  if (statSync(resolve(evidencePath)).size < 1) throw new Error('Release report evidence must not be empty.');
  parseJsonObject(signatureBundle, 'Release report Sigstore bundle');
  const { identity, issuer } = requireSigner(certificateIdentity, oidcIssuer);

  runCosign([
    'verify-blob', resolve(evidencePath),
    '--bundle', signatureBundle,
    '--certificate-identity', identity,
    '--certificate-oidc-issuer', issuer,
  ], 'release report evidence signature');

  if (!registryAttestationRequired) return;

  const output = runCosign([
    'verify-attestation', imageRef,
    '--type', REPORT_ATTESTATION_TYPE,
    '--certificate-identity', identity,
    '--certificate-oidc-issuer', issuer,
  ], 'release report registry attestation');
  const image = imageIdentity(imageRef);
  const statements = parseAttestations(output).map(statementFromAttestation).filter(Boolean);
  if (!statements.some((statement) => statementMatches(statement, evidence, image))) {
    throw new Error('No trusted registry attestation binds the exact report evidence to the release image digest.');
  }
}
