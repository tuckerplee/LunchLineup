import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import yaml from 'js-yaml';

const root = join(import.meta.dirname, '..', '..');
const compose = yaml.load(readFileSync(join(root, 'docker-compose.yml'), 'utf8'));

test('Compose has no privileged services and tightly scopes host-level exceptions', () => {
  for (const [serviceName, service] of Object.entries(compose.services)) {
    assert.notEqual(service.privileged, true, `${serviceName} must not be privileged`);
  }

  const rootUsers = Object.entries(compose.services)
    .filter(([, service]) => /^(?:0|root)(?::(?:0|root))?$/.test(String(service.user ?? '')))
    .map(([serviceName]) => serviceName);
  assert.deepEqual(rootUsers, []);

  const dockerSocketServices = Object.entries(compose.services)
    .filter(([, service]) => service.volumes?.some((volume) => String(volume).includes('/var/run/docker.sock')))
    .map(([serviceName]) => serviceName);
  assert.deepEqual(dockerSocketServices, ['autoheal']);
  assert.ok(compose.services.autoheal.profiles?.includes('ops'));

  const hostPidServices = Object.entries(compose.services)
    .filter(([, service]) => service.pid === 'host')
    .map(([serviceName]) => serviceName);
  assert.deepEqual(hostPidServices, ['node-exporter']);
});

test('tmpfs exceptions are bounded and disable executable, setuid, and device files', () => {
  for (const [serviceName, service] of Object.entries(compose.services)) {
    for (const entry of service.tmpfs ?? []) {
      assert.match(entry, /:rw,/i, `${serviceName} tmpfs must be explicitly writable`);
      assert.match(entry, /(?:^|,)noexec(?:,|$)/i, `${serviceName} tmpfs must disable executable files`);
      assert.match(entry, /(?:^|,)nosuid(?:,|$)/i, `${serviceName} tmpfs must disable setuid files`);
      assert.match(entry, /(?:^|,)nodev(?:,|$)/i, `${serviceName} tmpfs must disable device files`);
      assert.match(entry, /(?:^|,)size=\d+[kmg](?:,|$)/i, `${serviceName} tmpfs must have a size limit`);
    }
  }
});
