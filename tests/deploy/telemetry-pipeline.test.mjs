import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('Compose runs no tracing, log-storage or log-shipping services and sets no OTLP endpoint', () => {
  const compose = read('docker-compose.yml');

  for (const removed of ['otel-collector', 'tempo', 'loki', 'promtail']) {
    assert.doesNotMatch(compose, new RegExp(`^  ${removed}:`, 'm'));
    assert.ok(!compose.includes(removed), `docker-compose.yml must not mention ${removed}`);
  }
  assert.doesNotMatch(compose, /OTEL_EXPORTER_OTLP/);
  assert.doesNotMatch(compose, /^  telemetry:/m);
  for (const removedFile of [
    'infrastructure/otel-collector/otel-collector-config.yml',
    'infrastructure/tempo/tempo-config.yml',
    'infrastructure/loki/loki-config.yml',
    'infrastructure/promtail/promtail-config.yml',
    'infrastructure/docker/Dockerfile.otel-collector',
  ]) {
    assert.ok(!existsSync(join(root, removedFile)), `${removedFile} must stay removed`);
  }
});

test('application containers log to the Docker json-file driver that the estate Alloy shipper reads', () => {
  const compose = read('docker-compose.yml');

  assert.match(compose, /x-locked-runtime: &locked-runtime[\s\S]*?logging:\s*\n\s*driver: json-file/);
  assert.match(compose, /x-read-only-runtime: &read-only-runtime[\s\S]*?logging:\s*\n\s*driver: json-file/);
  assert.doesNotMatch(compose, /driver: (?:loki|fluentd|gelf|syslog|awslogs)/);
});

test('tracers stay dormant without an OTLP endpoint (tracing is not an estate system)', () => {
  assert.match(read('apps/api/src/common/telemetry.ts'), /if \(!endpoint\) \{\s*return null;/);
  assert.match(read('apps/worker/src/telemetry.py'), /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
  assert.match(read('apps/engine/src/telemetry.py'), /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
});

test('Python tracers propagate W3C context across the worker-engine gRPC boundary', () => {
  const worker = read('apps/worker/main.py');
  const engine = read('apps/engine/main.py');
  assert.match(worker, /metadata=current_trace_metadata\(\)/);
  assert.match(engine, /extracted_context\(context\.invocation_metadata\(\)\)/);
  assert.match(worker, /start_as_current_span\("worker\.process_job"\)/);
  assert.match(engine, /start_as_current_span\([\s\S]*"engine\.schedule_solve"/);
});
