import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

function sourceFiles(path) {
  const absolute = join(root, path);
  return readdirSync(absolute).flatMap((name) => {
    const child = join(absolute, name);
    if (statSync(child).isDirectory()) {
      if (name === 'status') return [];
      return sourceFiles(join(path, name));
    }
    return /\.(?:ts|tsx)$/.test(name) ? [child] : [];
  });
}

test('API-01 browser and web-server transports have no v1 application target', () => {
  const sources = [
    ...sourceFiles('apps/web/app'),
    ...sourceFiles('apps/web/lib'),
    join(root, 'apps/web/proxy.ts'),
  ];
  for (const path of sources) {
    const source = readFileSync(path, 'utf8');
    assert.doesNotMatch(source, /\/api\/v1(?:\/|['"`])/i, path);
    assert.doesNotMatch(source, /api:3000\/v1/i, path);
  }

  const client = read('apps/web/lib/client-api.ts');
  assert.match(client, /const API_V2 = '\/api\/v2'/);
  assert.match(client, /applicationApiOperation\(normalized, method\)/);
  assert.match(client, /toApiPath\('\/auth\/refresh', 'POST'\)/);

  const proxy = read('apps/web/proxy.ts');
  const logout = read('apps/web/app/auth/logout/route.ts');
  assert.match(proxy, /INTERNAL_API_V2_URL/);
  assert.match(proxy, /http:\/\/api-v2:3002\/v2/);
  assert.match(logout, /INTERNAL_API_V2_URL/);
  assert.match(logout, /http:\/\/api-v2:3002\/v2/);
});

test('API-01 browser route interceptors cannot silently remain on v1', () => {
  for (const path of sourceFiles('apps/web/tests/e2e')) {
    const routeLines = readFileSync(path, 'utf8')
      .split(/\r?\n/)
      .filter((line) => /\.(?:route|waitForRequest|waitForResponse)\(/.test(line));
    for (const line of routeLines) {
      assert.ok(
        !line.includes('/api/v1') && !line.includes('\\/api\\/v1'),
        `${path} contains a browser interceptor that still targets API v1: ${line.trim()}`,
      );
    }
  }
});

test('API-01 uses one explicit shared route catalog and no wildcard compatibility route', () => {
  const catalog = read('packages/api-contract/src/application.ts');
  const routes = read('apps/api-v2/src/application/routes.ts');
  const operationCount = [...catalog.matchAll(/\{ operationId: '/g)].length;

  assert.equal(operationCount, 121);
  assert.match(routes, /APPLICATION_API_OPERATIONS/);
  assert.match(routes, /url: `\/v2\$\{operation\.path\}`/);
  assert.doesNotMatch(routes, /\/v2\/\*/);
  assert.doesNotMatch(routes, /:\*|catchAll|passthrough/i);

  for (const forbidden of [
    "method: 'POST', path: '/shifts'",
    "method: 'PUT', path: '/shifts/:shiftId'",
    "method: 'DELETE', path: '/shifts/:shiftId'",
    "method: 'POST', path: '/schedules/:scheduleId/publish'",
    'demo-shift-05-casey-v1',
  ]) {
    assert.ok(!catalog.includes(forbidden), `forbidden legacy browser operation present: ${forbidden}`);
  }
});

test('API-02 owns current-session validation natively without a v1 identity hop', () => {
  const server = read('apps/api-v2/src/server.ts');
  const routes = read('apps/api-v2/src/application/routes.ts');
  const identity = read('apps/api-v2/src/platform/identity.ts');
  const nativeIdentity = read('apps/api-v2/src/platform/native-identity.ts');
  const config = read('apps/api-v2/src/config.ts');

  assert.match(server, /new NativeIdentityAdapter\(config, database\)/);
  assert.match(routes, /operation\.operationId === 'getCurrentSession'/);
  assert.match(routes, /dependencies\.identity\.authenticate/);
  assert.match(nativeIdentity, /transaction\.session\.findFirst/);
  assert.match(nativeIdentity, /transaction\.roleAssignment\.findMany/);
  assert.match(nativeIdentity, /session_mfa:/);
  assert.doesNotMatch(nativeIdentity, /fetch\(/);
  assert.doesNotMatch(identity, /LegacyIdentityAdapter|fetch\(/);
  assert.doesNotMatch(config, /LEGACY_IDENTITY_URL|IDENTITY_TIMEOUT_MS/);
  assert.match(config, /LEGACY_API_BASE_URL/);
  assert.match(config, /AUTH_STATE_TIMEOUT_MS/);
});

test('API-02 owns locations natively with public UUIDs and a bounded retained translation seam', () => {
  const catalog = read('packages/api-contract/src/application.ts');
  const locations = read('apps/api-v2/src/locations/routes.ts');
  const service = read('apps/api-v2/src/locations/locations.service.ts');
  const bridge = read('apps/api-v2/src/platform/retained-application.bridge.ts');
  const translator = read('apps/api-v2/src/locations/identifier-translation.ts');
  const server = read('apps/api-v2/src/server.ts');
  const web = read('apps/web/app/dashboard/locations/LocationsWorkspace.tsx');

  for (const operationId of [
    'listLocations',
    'createLocation',
    'getLocationSummary',
    'getLocation',
    'updateLocation',
    'deleteLocation',
  ]) {
    assert.match(catalog, new RegExp(`operationId: '${operationId}'[^\\n]*native: true`));
  }
  assert.match(locations, /registerLocationRoutes/);
  assert.match(locations, /LocationPathSchema/);
  assert.match(service, /publicId: randomUUID\(\)/);
  assert.match(service, /SELECT \"id\", \"publicId\"::text AS \"publicId\"/);
  assert.match(server, /LocationIdentifierTranslator/);
  assert.match(bridge, /IdentifierTranslator/);
  assert.match(translator, /locationId/);
  assert.match(translator, /locationIds/);
  assert.doesNotMatch(translator, /key === 'id'/);
  assert.doesNotMatch(web, /publicId\?: string/);
  assert.match(web, /dashboard\/scheduling\?location=\$\{location\.id\}/);
});

test('API-02 owns People natively with public role/user UUIDs and one explicit deactivation seam', () => {
  const catalog = read('packages/api-contract/src/application.ts');
  const server = read('apps/api-v2/src/server.ts');
  const routes = read('apps/api-v2/src/people/routes.ts');
  const service = read('apps/api-v2/src/people/people.service.ts');
  const translator = read('apps/api-v2/src/people/identifier-translation.ts');
  const schema = read('packages/db/prisma/schema.prisma');
  const migration = read('packages/db/prisma/migrations/pre_20260719_api_v2_role_public_ids.sql');

  for (const operationId of [
    'listStaffMembers',
    'getAccessCatalog',
    'getStaffSchedulingProfile',
    'updateStaffSchedulingProfile',
    'getStaffMember',
    'createStaffInvitation',
    'getStaffInvitation',
    'retryStaffInvitation',
    'reissueStaffInvitation',
    'resetStaffPin',
    'replaceCurrentPin',
    'getStaffAccess',
    'updateStaffAccess',
    'createAccessRole',
    'updateAccessRole',
    'deleteAccessRole',
  ]) {
    assert.match(catalog, new RegExp(`operationId: '${operationId}'[^\\n]*native: true`));
  }
  assert.doesNotMatch(catalog, /operationId: 'deleteStaffMember'[^\n]*native: true/);
  assert.match(server, /new PeopleService\(database, config\)/);
  assert.match(server, /new PeopleIdentifierTranslator\(people\)/);
  assert.match(routes, /registerPeopleRoutes/);
  assert.match(service, /publicId: true/);
  assert.match(translator, /userId/);
  assert.match(translator, /userIds/);
  assert.doesNotMatch(translator, /key === 'id'/);
  assert.match(schema, /model Role \{[\s\S]*?publicId\s+String\s+@unique/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS "publicId" UUID/);
  assert.match(migration, /Role_publicId_key/);
});

test('public build and deployment defaults select API v2', () => {
  for (const [path, expected] of [
    ['.env.example', 'NEXT_PUBLIC_API_URL=/api/v2'],
    ['docker-compose.yml', 'NEXT_PUBLIC_API_URL: ${NEXT_PUBLIC_API_URL:-/api/v2}'],
    ['infrastructure/docker/Dockerfile.web', 'ARG NEXT_PUBLIC_API_URL=/api/v2'],
    ['scripts/bootstrap-vm107-dev.sh', 'upsert_env NEXT_PUBLIC_API_URL "/api/v2"'],
    ['scripts/write-smoke-env.mjs', "NEXT_PUBLIC_API_URL: '/api/v2'"],
  ]) {
    assert.ok(read(path).includes(expected), `${path} does not default the browser to API v2`);
  }
});

test('consumer-facing compliance and operator docs use v2 application routes', () => {
  for (const path of [
    'docs/compliance/privacy-security.md',
    'docs/runbooks/data-retention-delete-export.md',
    'docs/runbooks/outbound-delivery.md',
  ]) {
    const source = read(path);
    assert.doesNotMatch(source, /\/api\/v1\/(?:users|admin\/(?:account|tenants))(?:\/|`)/, path);
  }

  const retentionRunbook = read('docs/runbooks/data-retention-delete-export.md');
  assert.match(retentionRunbook, /\/api\/v1\/admin\/retention\/purge-expired/);
  assert.match(retentionRunbook, /\/api\/v2\/admin\/account\/export/);
});
