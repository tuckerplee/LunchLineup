import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('Compose keeps trace ingestion internal and wires all application tracers', () => {
  const compose = read('docker-compose.yml');
  assert.match(compose, /otel-collector:[\s\S]*opentelemetry-collector-contrib:0\.153\.0@sha256:[a-f0-9]{64}/);
  assert.match(compose, /telemetry:[\s\S]*internal: true/);
  assert.doesNotMatch(compose.match(/  otel-collector:[\s\S]*?(?=\n  [a-z-]+:|\nnetworks:)/)?.[0] ?? '', /\n\s+ports:/);

  for (const serviceName of ['lunchlineup-api', 'lunchlineup-worker', 'lunchlineup-engine']) {
    const source = serviceName === 'lunchlineup-api'
      ? `${read('apps/api/src/common/telemetry.ts')}\n${compose}`
      : serviceName === 'lunchlineup-worker'
        ? `${read('apps/worker/main.py')}\n${compose}`
        : `${read('apps/engine/main.py')}\n${compose}`;
    assert.match(source, /OTEL_EXPORTER_OTLP_TRACES_ENDPOINT/);
    assert.match(source, new RegExp(serviceName));
  }
});

test('collector applies memory protection, batching, queued retry, and exports to Tempo', () => {
  const config = read('infrastructure/otel-collector/otel-collector-config.yml');
  assert.match(config, /memory_limiter:/);
  assert.match(config, /batch:/);
  assert.match(config, /sending_queue:[\s\S]*enabled: true/);
  assert.match(config, /retry_on_failure:[\s\S]*enabled: true/);
  assert.match(config, /endpoint: http:\/\/tempo:4318/);
  assert.match(config, /receivers: \[otlp\][\s\S]*processors: \[memory_limiter, batch\][\s\S]*exporters: \[otlphttp\/tempo\]/);
});

test('Promtail ships Docker JSON logs without the Docker control socket or a host port', () => {
  const compose = read('docker-compose.yml');
  const config = read('infrastructure/promtail/promtail-config.yml');
  const block = compose.match(/  promtail:[\s\S]*?(?=\n  [a-z-]+:|\nnetworks:)/)?.[0] ?? '';

  assert.match(block, /grafana\/promtail:2\.9\.7@sha256:[a-f0-9]{64}/);
  assert.match(block, /\/var\/lib\/docker\/containers:\/var\/lib\/docker\/containers:ro/);
  assert.doesNotMatch(block, /docker\.sock/);
  assert.doesNotMatch(block, /\n\s+ports:/);
  assert.match(config, /__path__: \/var\/lib\/docker\/containers\/\*\/\*-json\.log/);
  assert.match(config, /docker: \{\}/);
  assert.match(config, /url: http:\/\/loki:3100\/loki\/api\/v1\/push/);
});

test('Python tracers propagate W3C context across the worker-engine gRPC boundary', () => {
  const worker = read('apps/worker/main.py');
  const engine = read('apps/engine/main.py');
  assert.match(worker, /metadata=current_trace_metadata\(\)/);
  assert.match(engine, /extracted_context\(context\.invocation_metadata\(\)\)/);
  assert.match(worker, /start_as_current_span\("worker\.process_job"\)/);
  assert.match(engine, /start_as_current_span\([\s\S]*"engine\.schedule_solve"/);
});
