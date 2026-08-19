import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = join(import.meta.dirname, '..', '..');
const read = (path) => readFileSync(join(root, path), 'utf8');
const compose = yaml.load(read('docker-compose.yml'));

const capabilityLockedServices = [
  'proxy',
  'web',
  'api',
  'api-v2',
  'webhook-replay',
  'migrate',
  'engine',
  'worker',
  'pdf-parser',
  'pitr-wal-provider',
  'pitr-lifecycle-audit',
  'control',
  'autoheal',
  'prometheus',
  'backup',
  'alertmanager',
  'node-exporter',
  'loki',
  'promtail',
  'otel-collector',
  'tempo',
  'grafana',
];

const startupCapabilityServices = [
  'pgbouncer',
  'postgres',
  'redis',
  'rabbitmq',
  'pitr-base-backup',
  'pitr-restore',
];

test('production services use read-only roots and deny privilege escalation', () => {
  const expectedServices = [...capabilityLockedServices, ...startupCapabilityServices].sort();
  assert.deepEqual(Object.keys(compose.services).sort(), expectedServices);

  for (const serviceName of expectedServices) {
    const service = compose.services[serviceName];
    assert.equal(service.read_only, true, `${serviceName} must use a read-only root filesystem`);
    assert.ok(
      service.security_opt?.includes('no-new-privileges:true'),
      `${serviceName} must deny privilege escalation`,
    );
    assert.ok(
      service.tmpfs?.some((entry) => entry.startsWith('/tmp:') && entry.includes('noexec') && entry.includes('nosuid') && entry.includes('nodev')),
      `${serviceName} must use a bounded, hardened /tmp tmpfs`,
    );
  }
});

test('stateless and application services drop every Linux capability', () => {
  for (const serviceName of capabilityLockedServices) {
    const service = compose.services[serviceName];
    assert.deepEqual(service.cap_drop, ['ALL'], `${serviceName} must drop all capabilities`);
    if (serviceName === 'proxy') {
      assert.deepEqual(service.cap_add, ['NET_BIND_SERVICE']);
    } else {
      assert.equal(service.cap_add, undefined, `${serviceName} must not add capabilities`);
    }
  }

  for (const serviceName of startupCapabilityServices) {
    assert.equal(
      compose.services[serviceName].cap_add,
      undefined,
      `${serviceName} must not add capabilities while retaining image startup defaults`,
    );
  }
});

test('production services bound compute, processes, file descriptors, and local logs', () => {
  for (const [serviceName, service] of Object.entries(compose.services)) {
    assert.ok(Number(service.cpus) > 0, `${serviceName} must have a positive CPU limit`);
    assert.match(
      String(service.mem_limit),
      /^\d+(?:\.\d+)?[kmg]$/i,
      `${serviceName} must have an explicit memory limit`,
    );
    assert.ok(
      Number.isInteger(service.pids_limit) && service.pids_limit > 0,
      `${serviceName} must have a positive PID limit`,
    );
    assert.ok(service.ulimits?.nofile?.soft >= 1024, `${serviceName} must bound open files`);
    assert.ok(
      service.ulimits?.nofile?.hard >= service.ulimits?.nofile?.soft,
      `${serviceName} hard open-file limit must cover its soft limit`,
    );
    assert.equal(service.logging?.driver, 'json-file', `${serviceName} must use bounded local logs`);
    assert.match(
      String(service.logging?.options?.['max-size']),
      /^\d+[kmg]$/i,
      `${serviceName} must rotate logs by size`,
    );
    assert.ok(
      Number(service.logging?.options?.['max-file']) > 0,
      `${serviceName} must retain a bounded number of log files`,
    );
  }
});
test('runtime write access is limited to explicit state, cache, upload, and temp mounts', () => {
  assert.ok(compose.services.web.tmpfs.some((entry) => entry.startsWith('/app/.next/cache:')));
  assert.ok(compose.services.api.volumes.includes('availability_uploads:/app/uploads'));
  assert.ok(compose.services.worker.volumes.includes('availability_uploads:/app/uploads'));
  assert.match(compose.volumes.availability_uploads.driver_opts.o, /size=268435456/);
  assert.match(compose.volumes.availability_uploads.driver_opts.o, /noexec/);
  assert.match(compose.volumes.availability_uploads.driver_opts.o, /nosuid/);
  assert.match(compose.volumes.availability_uploads.driver_opts.o, /nodev/);
  assert.ok(compose.services.api.volumes.includes('tenant_export_artifacts:/var/lib/lunchlineup/tenant-exports'));
  assert.ok(compose.services.postgres.tmpfs.some((entry) => entry.startsWith('/var/run/postgresql:')));
  assert.ok(compose.services.pgbouncer.tmpfs.some((entry) => entry.startsWith('/etc/pgbouncer:')));
  assert.ok(compose.services.proxy.volumes.includes('./infrastructure/caddy/Caddyfile:/etc/caddy/Caddyfile:ro'));
  assert.ok(compose.services.redis.volumes.includes('./infrastructure/redis/redis.conf.template:/usr/local/etc/redis/redis.conf:ro'));
});


test('availability PDF parsing runs in a secret-free no-network container boundary', () => {
  const parser = compose.services['pdf-parser'];
  assert.equal(parser.network_mode, 'none');
  assert.equal(parser.networks, undefined);
  assert.equal(parser.privileged, undefined);
  assert.equal(parser.pid, undefined);
  assert.equal(parser.devices, undefined);
  assert.equal(parser.init, true);
  assert.deepEqual(parser.command, ['python', '-m', 'src.parser.pdf_service']);
  assert.deepEqual(parser.volumes, ['parser_ipc:/run/lunchlineup-parser']);
  assert.ok(compose.services.worker.volumes.includes('parser_ipc:/run/lunchlineup-parser'));
  assert.equal(compose.services.worker.depends_on['pdf-parser'].condition, 'service_healthy');
  assert.equal(compose.services.worker.healthcheck.start_period, "15s");
  assert.match(compose.services.worker.healthcheck.test.at(-1), /lunchlineup_pdf_parser_ready/);
  assert.ok(compose.services.worker.environment.includes("PARSER_SOCKET_PATH=/run/lunchlineup-parser/parser.sock"));
  assert.ok(compose.services.worker.environment.some((entry) => entry.startsWith("WORKER_PDF_PARSER_HEALTH_POLL_SECONDS=")));
  assert.match(read("apps/worker/main.py"), /run_pdf_parser_health_loop/);
  assert.deepEqual(
    parser.healthcheck.test,
    ['CMD', 'python', '-m', 'src.parser.pdf_sandbox', '--health'],
  );

  const environment = parser.environment ?? [];
  assert.ok(environment.length > 0);
  for (const entry of environment) {
    assert.doesNotMatch(
      entry,
      /DATABASE|RABBIT|STRIPE|RESEND|EMAIL|SECRET|TOKEN|PASSWORD|OTEL|ENGINE/i,
      'isolated parser must not receive production service credentials',
    );
  }

  const ipcOptions = compose.volumes.parser_ipc.driver_opts.o;
  assert.match(ipcOptions, /size=1048576/);
  assert.match(ipcOptions, /mode=0700/);
  assert.match(ipcOptions, /uid=10001/);
  assert.match(ipcOptions, /gid=10001/);
  assert.match(ipcOptions, /noexec/);
  assert.match(ipcOptions, /nosuid/);
  assert.match(ipcOptions, /nodev/);

  const clientSource = read('apps/worker/src/parser/pdf_sandbox.py');
  const serviceSource = read('apps/worker/src/parser/pdf_service.py');
  assert.doesNotMatch(clientSource, /pdf_parser|pypdf/);
  assert.match(serviceSource, /if parsed_document:\s+return STATUS_OK/);
  assert.match(read('infrastructure/docker/Dockerfile.worker'), /\/run\/lunchlineup-parser/);
});

test('release application images declare non-root runtime users', () => {
  for (const name of ['api', 'api-v2', 'control', 'engine', 'migrations', 'web', 'worker']) {
    const dockerfile = read(`infrastructure/docker/Dockerfile.${name}`);
    const users = [...dockerfile.matchAll(/^USER\s+([^\s#]+).*$/gm)].map((match) => match[1]);
    assert.ok(users.length > 0, `Dockerfile.${name} must declare a runtime USER`);
    assert.doesNotMatch(users.at(-1), /^(?:0|root)(?::(?:0|root))?$/, `Dockerfile.${name} runtime USER must be non-root`);
  }
});
