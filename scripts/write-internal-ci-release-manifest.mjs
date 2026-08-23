import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const services = [
  'api', 'api-v2', 'web', 'engine', 'worker', 'migrate', 'control', 'backup', 'proxy',
  'pgbouncer', 'postgres', 'node-exporter', 'loki', 'tempo', 'grafana', 'alertmanager',
  'otel-collector',
];
const sourceSha = process.env.CI_COMMIT_SHA ?? '';
const imagePrefix = process.env.IMAGE_PREFIX ?? '';
const imageTag = process.env.IMAGE_TAG ?? '';
const output = process.argv[2];

if (!/^[a-f0-9]{40}$/.test(sourceSha) || imageTag !== sourceSha || !imagePrefix || !output) {
  throw new Error('CI_COMMIT_SHA, IMAGE_PREFIX, IMAGE_TAG, and an output path are required.');
}
const images = Object.fromEntries(services.map((service) => {
  const ref = `${imagePrefix}/${service}:${sourceSha}`;
  const localImageId = execFileSync('docker', ['image', 'inspect', '--format', '{{.Id}}', ref], {
    encoding: 'utf8',
  }).trim();
  if (!/^sha256:[a-f0-9]{64}$/.test(localImageId)) throw new Error(`Unable to resolve ${ref}.`);
  return [service, { ref, localImageId }];
}));
const manifest = {
  version: 1,
  kind: 'lunchlineup-internal-ci-release-manifest',
  releaseTarget: 'internal-beta',
  sourceSha,
  sourceRef: process.env.CI_REF,
  runId: process.env.CI_RUN_ID,
  imagePrefix,
  imageTag,
  images,
};
const target = resolve(output);
mkdirSync(dirname(target), { recursive: true });
writeFileSync(target, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: 'utf8', flag: 'wx', mode: 0o600 });
console.log(`internal_ci_release_manifest_ok source_sha=${sourceSha} images=${services.length}`);
