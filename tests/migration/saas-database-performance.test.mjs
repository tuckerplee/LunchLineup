import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const read = (path) => readFileSync(join(root, path), 'utf8');

test('high-growth tenant reads have schema-aligned composite indexes', () => {
  const schema = read('packages/db/prisma/schema.prisma');
  const migration = read('packages/db/prisma/migrations/20260714_saas_hot_path_indexes.sql');

  const indexes = [
    {
      schema: '@@index([tenantId, deletedAt, createdAt, id])',
      sql: '"User_tenantId_deletedAt_createdAt_id_idx"',
      table: 'ON "User"("tenantId", "deletedAt", "createdAt", "id")',
    },
    {
      schema: '@@index([tenantId, deletedAt, name, id])',
      sql: '"Location_tenantId_deletedAt_name_id_idx"',
      table: 'ON "Location"("tenantId", "deletedAt", "name", "id")',
    },
    {
      schema: '@@index([tenantId, deletedAt, startDate(sort: Desc), id(sort: Desc)])',
      sql: '"Schedule_tenantId_deletedAt_startDate_id_idx"',
      table: 'ON "Schedule"("tenantId", "deletedAt", "startDate" DESC, "id" DESC)',
    },
    {
      schema: '@@index([tenantId, deletedAt, startTime, id])',
      sql: '"Shift_tenantId_deletedAt_startTime_id_idx"',
      table: 'ON "Shift"("tenantId", "deletedAt", "startTime", "id")',
    },
    {
      schema: '@@index([tenantId, deletedAt, clockInAt(sort: Desc), id(sort: Desc)])',
      sql: '"TimeCard_tenantId_deletedAt_clockInAt_id_idx"',
      table: 'ON "TimeCard"("tenantId", "deletedAt", "clockInAt" DESC, "id" DESC)',
    },
    {
      schema: '@@index([tenantId, userId, deletedAt, clockInAt(sort: Desc), id(sort: Desc)])',
      sql: '"TimeCard_tenantId_userId_deletedAt_clockInAt_id_idx"',
      table: 'ON "TimeCard"("tenantId", "userId", "deletedAt", "clockInAt" DESC, "id" DESC)',
    },
  ];

  for (const index of indexes) {
    assert.ok(schema.includes(index.schema), 'missing Prisma index ' + index.schema);
    assert.ok(migration.includes('CREATE INDEX IF NOT EXISTS ' + index.sql), 'missing migration index ' + index.sql);
    assert.ok(migration.includes(index.table), 'migration index has wrong field order: ' + index.sql);
  }
});

test('tenant list and timeline reads use deterministic index-compatible ordering', () => {
  const users = read('apps/api/src/users/users.controller.ts');
  const locations = read('apps/api/src/locations/locations.controller.ts');
  const schedules = read('apps/api/src/schedules/schedules.controller.ts');
  const shifts = read('apps/api/src/shifts/shifts.controller.ts');
  const timeCards = read('apps/api/src/time-cards/time-cards.controller.ts');

  assert.ok(users.includes("orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]"));
  assert.ok(locations.includes("orderBy: [{ name: 'asc' }, { id: 'asc' }]"));
  assert.ok(schedules.includes('orderBy: [{ startDate: "desc" }, { id: "desc" }]'));
  assert.ok(shifts.includes("orderBy: [{ startTime: 'asc' }, { id: 'asc' }]"));
  assert.ok(timeCards.includes("orderBy: [{ clockInAt: 'desc' }, { id: 'desc' }]"));
});

test('user directory role loading is batched instead of issuing one query per user', () => {
  const users = read('apps/api/src/users/users.controller.ts');

  assert.ok(users.includes('roleAssignment.findMany({'));
  assert.ok(users.includes('userId: { in: page.data.map((user) => user.id) }'));
  assert.ok(users.includes('roleAssignmentsByUser'));
  assert.ok(!users.includes('users.map((user) => this.rbacService.getUserRoleAssignments'));
});

test('time-card history is cursor-paged end to end', () => {
  const controller = read('apps/api/src/time-cards/time-cards.controller.ts');
  const api = read('apps/web/app/dashboard/time-cards/time-card-api.ts');
  const workspace = read('apps/web/app/dashboard/time-cards/TimeCardsWorkspace.tsx');
  const history = read('apps/web/app/dashboard/time-cards/TimeCardHistory.tsx');

  assert.ok(controller.includes('const DEFAULT_TIME_CARD_PAGE_SIZE = 100'));
  assert.ok(controller.includes('const MAX_TIME_CARD_PAGE_SIZE = 250'));
  assert.ok(controller.includes('take: pageSize + 1'));
  assert.ok(controller.includes("cursor: { id: cursor }, skip: 1"));
  assert.ok(controller.includes('nextCursor'));
  assert.ok(api.includes("if (cursor) query.set('cursor', cursor);"));
  assert.ok(api.includes("/time-cards?' + timeCardQuery(userId, canManageTeam, cursor)"));
  assert.ok(workspace.includes('fetchEarlierTimeCards(userId, canManageTeam, cursor)'));
  assert.ok(history.includes('Load earlier records'));
});
