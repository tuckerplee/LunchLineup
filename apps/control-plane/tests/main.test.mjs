import assert from 'node:assert/strict';
import { request as httpRequest, createServer } from 'node:http';
import test from 'node:test';
import controlPlane from '../dist/main.js';

const { createApp, loadConfig } = controlPlane;

const fakeDocker = {
  async listContainers() {
    return [
      {
        State: 'running',
        Status: 'Up 12 seconds',
        Labels: {
          'com.docker.compose.service': 'api',
        },
      },
    ];
  },
};

const protectedConfig = {
  host: '127.0.0.1',
  port: 0,
  expectedServices: ['api'],
  adminToken: 'test-admin-token',
  metricsToken: 'test-metrics-token',
  requireAdminToken: true,
  requireMetricsToken: true,
  dockerStatusEnabled: true,
  dockerSocketPath: '/var/run/docker.sock',
};

test('configuration defaults to loopback, token protection, and disabled Docker status', () => {
  const config = loadConfig({});

  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.requireAdminToken, false);
  assert.equal(config.requireMetricsToken, false);
  assert.equal(config.dockerStatusEnabled, false);
  assert.equal(config.dockerSocketPath, undefined);
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production' }),
    /CONTROL_PLANE_ADMIN_TOKEN/,
  );
  assert.throws(
    () => loadConfig({ NODE_ENV: 'production', CONTROL_PLANE_ADMIN_TOKEN: 'admin-token' }),
    /CONTROL_PLANE_METRICS_TOKEN/,
  );
  const productionConfig = loadConfig({
    NODE_ENV: 'production',
    CONTROL_PLANE_ADMIN_TOKEN: 'admin-token',
    CONTROL_PLANE_METRICS_TOKEN: 'metrics-token',
  });
  assert.equal(productionConfig.requireAdminToken, true);
  assert.equal(productionConfig.requireMetricsToken, true);
  assert.notEqual(
    productionConfig.adminToken,
    productionConfig.metricsToken,
  );
  assert.throws(
    () => loadConfig({ CONTROL_PLANE_DOCKER_STATUS: 'enabled' }),
    /CONTROL_PLANE_DOCKER_SOCKET_PATH/,
  );
  assert.equal(
    loadConfig({
      CONTROL_PLANE_DOCKER_STATUS: 'enabled',
      CONTROL_PLANE_DOCKER_SOCKET_PATH: '/var/run/docker.sock',
    }).dockerStatusEnabled,
    true,
  );
});

test('status and control namespace require the admin bearer token', async (t) => {
  const server = await listen(createApp(protectedConfig, fakeDocker));
  t.after(() => close(server));

  assert.equal((await request(server, '/api/status')).statusCode, 401);
  assert.equal((await request(server, '/api/control/restart')).statusCode, 401);

  const authHeaders = { Authorization: 'Bearer test-admin-token' };
  const status = await request(server, '/api/status', authHeaders);
  assert.equal(status.statusCode, 200);
  assert.match(status.body, /"source":"docker"/);

  assert.equal(
    (await request(server, '/api/status', { Authorization: 'Bearer test-metrics-token' })).statusCode,
    401,
  );

  const futureControlRoute = await request(server, '/api/control/restart', authHeaders);
  assert.equal(futureControlRoute.statusCode, 404);
});

test('metrics route accepts only the metrics bearer token', async (t) => {
  const server = await listen(createApp(protectedConfig, fakeDocker));
  t.after(() => close(server));

  assert.equal((await request(server, '/api/metrics')).statusCode, 401);
  assert.equal(
    (await request(server, '/api/metrics', { Authorization: 'Bearer test-admin-token' })).statusCode,
    401,
  );

  const metrics = await request(server, '/api/metrics', { Authorization: 'Bearer test-metrics-token' });
  assert.equal(metrics.statusCode, 200);
  assert.match(metrics.body, /lunchlineup_control_plane_up 1/);
});

test('disabled Docker status does not query the socket client', async (t) => {
  let dockerQueried = false;
  const config = {
    ...protectedConfig,
    dockerStatusEnabled: false,
    dockerSocketPath: undefined,
  };
  const docker = {
    async listContainers() {
      dockerQueried = true;
      throw new Error('socket should stay closed');
    },
  };
  const server = await listen(createApp(config, docker));
  t.after(() => close(server));

  const status = await request(server, '/api/status', { Authorization: 'Bearer test-admin-token' });

  assert.equal(status.statusCode, 200);
  assert.equal(dockerQueried, false);
  assert.match(status.body, /"source":"disabled"/);
  assert.match(status.body, /docker_status_disabled/);
});

test('health endpoint stays non-sensitive and unauthenticated', async (t) => {
  const server = await listen(createApp(protectedConfig, fakeDocker));
  t.after(() => close(server));

  const response = await request(server, '/api/health');
  assert.equal(response.statusCode, 200);
  assert.match(response.body, /"service":"control-plane"/);
});

test('request failures never log parser messages or secret-bearing request content', async (t) => {
  const server = await listen(createApp(protectedConfig, fakeDocker));
  const originalError = console.error;
  const logs = [];
  console.error = (...args) => logs.push(args.join(' '));
  t.after(() => {
    console.error = originalError;
    return close(server);
  });

  const response = await request(
    server,
    '/api/status',
    { 'content-type': 'application/json' },
    'POST',
    '{"token":"request-secret"',
  );

  assert.equal(response.statusCode, 500);
  assert.doesNotMatch(response.body, /request-secret/);
  assert.match(logs.join('\n'), /Control plane request failed category=unknown/);
  assert.doesNotMatch(logs.join('\n'), /request-secret|SyntaxError|stack/i);
});

function listen(app) {
  const server = createServer(app);
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve(server);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }
      resolve();
    });
  });
}

function request(server, path, headers = {}, method = 'GET', body) {
  const address = server.address();
  assert.ok(address && typeof address === 'object');

  return new Promise((resolve, reject) => {
    const req = httpRequest({
      hostname: '127.0.0.1',
      port: address.port,
      path,
      method,
      headers,
    }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => {
        body += chunk;
      });
      res.on('end', () => {
        resolve({
          body,
          headers: res.headers,
          statusCode: res.statusCode,
        });
      });
    });

    req.on('error', reject);
    if (body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}
