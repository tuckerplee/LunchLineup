#!/usr/bin/env node
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const args = process.argv.slice(2);
const option = (name) => {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : null;
};
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');
const expectedIdentity = process.env.FAKE_SIGNER_IDENTITY;
const expectedIssuer = process.env.FAKE_SIGNER_ISSUER;

if (
  option('--certificate-identity') !== expectedIdentity
  || option('--certificate-oidc-issuer') !== expectedIssuer
) process.exit(1);

if (args[0] === 'verify-blob') {
  const artifactPath = args[1];
  const bundlePath = option('--bundle');
  const bundle = JSON.parse(readFileSync(bundlePath, 'utf8'));
  const valid = (
    bundle.valid === true
    && bundle.artifactSha256 === sha256(readFileSync(artifactPath))
    && bundle.certificateIdentity === expectedIdentity
    && bundle.oidcIssuer === expectedIssuer
  );
  process.exit(valid ? 0 : 1);
}

if (args[0] === 'verify-attestation') {
  if (option('--type') !== 'custom') process.exit(1);
  const imageRef = args[1];
  const match = /^(?<name>[^@]+)@sha256:(?<digest>[a-f0-9]{64})$/i.exec(imageRef);
  if (!match?.groups) process.exit(1);
  const repository = match.groups.name.replace(/:[^/:]+$/, '');
  const service = repository.split('/').at(-1);
  const kind = process.env.FAKE_REPORT_KIND;
  const evidencePath = join(process.env.FAKE_REPORTS_DIR, `${service}.${kind}-evidence.json`);
  const evidence = JSON.parse(readFileSync(evidencePath, 'utf8'));
  if (process.env.FAKE_ATTESTATION_FAILURE === 'predicate') evidence.reportSha256 = '0'.repeat(64);
  const digest = process.env.FAKE_ATTESTATION_FAILURE === 'subject'
    ? '0'.repeat(64)
    : match.groups.digest.toLowerCase();
  const statement = {
    _type: 'https://in-toto.io/Statement/v1',
    predicateType: 'https://cosign.sigstore.dev/attestation/v1',
    subject: [{ name: repository, digest: { sha256: digest } }],
    predicate: evidence,
  };
  process.stdout.write(JSON.stringify({
    payload: Buffer.from(JSON.stringify(statement)).toString('base64'),
  }));
  process.exit(0);
}

process.exit(2);