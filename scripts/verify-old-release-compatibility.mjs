#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyOldReleaseCompatibility(proof, { previousSha, candidateSha, now = Date.now(), maxAgeSeconds = 3600 }) {
  if (proof?.version !== 1 || proof.status !== 'passed') throw new Error('Compatibility proof must be a passed version 1 artifact.');
  if (proof.previousReleaseSha !== previousSha || proof.candidateReleaseSha !== candidateSha) throw new Error('Compatibility proof release SHAs do not match.');
  if (proof.database?.isolatedClone !== true || proof.database?.productionMutated !== false) throw new Error('Compatibility proof must use an isolated clone without production mutation.');
  if (proof.candidateSchema?.applied !== true || proof.oldReleaseSmoke?.status !== 'passed') throw new Error('Candidate schema and old-release smoke must both pass.');
  const completedAt = Date.parse(proof.completedAt ?? '');
  if (!Number.isFinite(completedAt) || completedAt > now + 300000 || now - completedAt > maxAgeSeconds * 1000) throw new Error('Compatibility proof is stale or has an invalid timestamp.');
  if (typeof proof.evidenceUri !== 'string' || !/^(https:\/\/|s3:\/\/|rclone:)/.test(proof.evidenceUri)) throw new Error('Compatibility proof must reference retained evidence.');
}

function main() {
  const [path, previousSha, candidateSha] = process.argv.slice(2);
  if (!path || !/^[a-f0-9]{40}$/i.test(previousSha ?? '') || !/^[a-f0-9]{40}$/i.test(candidateSha ?? '')) {
    throw new Error('Usage: verify-old-release-compatibility.mjs PROOF PREVIOUS_SHA CANDIDATE_SHA');
  }
  const proof = JSON.parse(readFileSync(resolve(path), 'utf8'));
  verifyOldReleaseCompatibility(proof, { previousSha: previousSha.toLowerCase(), candidateSha: candidateSha.toLowerCase() });
  process.stdout.write(`old_release_candidate_schema_compatibility_ok previous_sha=${previousSha} candidate_sha=${candidateSha}\n`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
