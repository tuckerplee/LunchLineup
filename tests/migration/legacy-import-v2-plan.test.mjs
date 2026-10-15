import assert from 'node:assert/strict';
import { createCipheriv, createHash } from 'node:crypto';
import test from 'node:test';
import { buildLegacyImportPlan, ROLE_PLAN_SHA256 } from '../../scripts/legacy-import-plan.mjs';
import {
  ADAPTER_VERSION_V2, V2_LIMIT_MAXIMA, classifyPasswordHash, deterministicId, parseClockMinutes, parseShiftHours, wallClockToUtc, mondayOf, SHIFT_BATCH_SIZE,
} from '../../scripts/legacy-import-v2.mjs';
import { appKeyFrom, assertScratchHost, buildDescriptor, decryptField, parseArgs, usernameHash } from '../../scripts/export-legacy-mysql.mjs';

// Pure checks of the legacy-combined-v2 planner and the exporter helpers. No
// database, no Docker: the round trip against real MariaDB/PostgreSQL is in
// legacy-mysql-roundtrip.integration.test.mjs.
const sha = (bytes) => createHash('sha256').update(bytes).digest('hex');
const generation = '22222222-2222-4222-8222-222222222222';
const bcryptY10 = `$2y$10$${'a'.repeat(53)}`;

function source(patch = {}) {
  return {
    format: 'legacy-combined-v2', skipped_tables: { audit_logs: 4 },
    companies: [{ id: 1, name: 'Co One' }],
    stores: [{ id: 10, company_id: 1, name: 'Store Ten', location: null }, { id: 11, company_id: 1, name: 'Store Eleven', location: 'Pier' }],
    users: [
      { id: 1, company_id: 1, username_plain: 'Boss@Example.test', password_hash: bcryptY10, home_store_id: 10 },
      { id: 2, company_id: 1, username_plain: 'lead', password_hash: bcryptY10, home_store_id: 10 },
      { id: 3, company_id: 1, username_plain: 'worker', password_hash: '$argon2id$v=19$x', home_store_id: 10 },
      { id: 4, company_id: 1, username_plain: 'viewer', password_hash: bcryptY10, home_store_id: 11 },
    ],
    staff: [
      { id: 1, store_id: 10, company_id: 1, name_plain: 'Bea Boss', is_admin: 1, pos: null, tasks: null, lunch_duration: 30 },
      { id: 3, store_id: 10, company_id: 1, name_plain: 'Walt Worker', is_admin: 0, pos: '["Cashier","Cashier"," Grill "]', tasks: '[1,"Prep"]', lunch_duration: 45 },
      { id: 2, store_id: 10, company_id: 1, name_plain: 'Coincidence', is_admin: 0, pos: null, tasks: null, lunch_duration: 30 },
      { id: 9, store_id: 11, company_id: 1, name_plain: 'Nolan NoLogin', is_admin: 0, pos: 'Floor', tasks: null, lunch_duration: null },
    ],
    user_company_roles: [{ user_id: 1, company_id: 1, role: 'company_admin' }],
    user_store_roles: [
      { user_id: 1, store_id: 10, role: 'store' }, { user_id: 2, store_id: 10, role: 'store' }, { user_id: 2, store_id: 10, role: 'schedule' },
      { user_id: 3, store_id: 10, role: 'store' }, { user_id: 3, store_id: 10, role: 'staff' }, { user_id: 4, store_id: 11, role: 'store' }, { user_id: 4, store_id: 11, role: 'custom_role' },
    ],
    shifts: [
      { id: 1, staff_id: 3, store_id: 10, date: '2026-03-09', shift_hours: '9:00 AM-5:00 PM', pos: 'Cashier', breaks: [{ start: '11:00 AM', duration: 10 }, { start: '1:00 PM', duration: 30 }], tasks: null, sign_off: null },
      { id: 2, staff_id: 3, store_id: 10, date: '2026-03-15', shift_hours: '10:00 PM-6:00 AM', breaks: null, break1: '', lunch: '1:00 AM', lunch_duration: '30' },
      { id: 3, staff_id: 9, store_id: 11, date: '2026-03-10', shift_hours: 'garbage' },
      { id: 4, staff_id: null, store_id: 11, date: '2026-03-10', shift_hours: '1pm - 5pm', pos: '  ' },
      { id: 5, staff_id: 9, store_id: 11, date: '0000-00-00', shift_hours: '9:00 AM-5:00 PM' },
    ],
    break_templates: [{ id: 1, company_id: null, name: 'Default', break1_offset: 2, break1_duration: 10, lunch_offset: 4, lunch_duration: 60, break2_offset: 2, break2_duration: 10 }],
    schedule_templates: [{ id: 1, name: 'Weekend', payload: '{}' }],
    chores: [], settings: [{ id: 1, scope: 'global', store_id: null, company_id: null, name: 'lunch_window_start', value: '11:00' }],
    ...patch,
  };
}
function plan(src = source(), descriptorPatch = {}) {
  const sourceBytes = Buffer.from(JSON.stringify(src));
  const descriptor = { schemaVersion: 1, namespace: 'unit-v2', targetGenerationId: generation, sourceSha256: sha(sourceBytes), adapterVersion: ADAPTER_VERSION_V2, rolePlanSha256: ROLE_PLAN_SHA256, companySlugs: { 1: 'legacy-company-1' }, timezone: 'America/Chicago', limits: { ...V2_LIMIT_MAXIMA }, ...descriptorPatch };
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  return buildLegacyImportPlan(sourceBytes, descriptorBytes, { expectedDescriptorSha256: sha(descriptorBytes), expectedSourceSha256: sha(sourceBytes) });
}

test('clock and shift-hour parsing accepts what the PHP app writes and common hand edits', () => {
  assert.deepEqual(parseShiftHours('9:00 AM-5:00 PM'), { start: 540, end: 1020 });
  assert.deepEqual(parseShiftHours('10:00 PM-6:00 AM'), { start: 1320, end: 1800 });
  assert.deepEqual(parseShiftHours('12:00 AM-8:00 AM'), { start: 0, end: 480 });
  assert.deepEqual(parseShiftHours('1pm - 5pm'), { start: 780, end: 1020 });
  assert.deepEqual(parseShiftHours('0900-1700'), { start: 540, end: 1020 });
  assert.deepEqual(parseShiftHours('13:30 to 21:00'), { start: 810, end: 1260 });
  assert.deepEqual(parseShiftHours('8:00 AM – 12:00 AM'), { start: 480, end: 1440 });
  for (const bad of ['', 'OFF', '9:00 AM-9:00 AM', '25:00-26:00', '9:00 AM', '9-5-7', null, 7, '13:00 PM-2:00 PM']) assert.equal(parseShiftHours(bad), null, String(bad));
  assert.equal(parseClockMinutes('12:00 PM'), 720);
  assert.equal(parseClockMinutes('12:30 AM'), 30);
  assert.equal(parseClockMinutes('24:00'), null);
  assert.equal(parseClockMinutes('24:00', { allowEndOfDay: true }), 1440);
});

test('local wall time maps to UTC through the IANA zone across DST transitions', () => {
  assert.equal(new Date(wallClockToUtc('2026-03-06', 8 * 60, 'America/Chicago')).toISOString(), '2026-03-06T14:00:00.000Z');
  assert.equal(new Date(wallClockToUtc('2026-03-09', 8 * 60, 'America/Chicago')).toISOString(), '2026-03-09T13:00:00.000Z');
  assert.equal(new Date(wallClockToUtc('2026-03-10', 9 * 60, 'America/Los_Angeles')).toISOString(), '2026-03-10T16:00:00.000Z');
  assert.equal(new Date(wallClockToUtc('2026-11-01', 90, 'America/Chicago')).toISOString().length, 24); // ambiguous time still resolves deterministically
  assert.equal(new Date(wallClockToUtc('2026-03-08', 150, 'America/Chicago')).getTime(), wallClockToUtc('2026-03-08', 150, 'America/Chicago')); // spring-forward gap resolves
  assert.equal(mondayOf('2026-03-08'), '2026-03-02');
  assert.equal(mondayOf('2026-03-09'), '2026-03-09');
});

test('password hash classification preserves bcrypt cost 4-14 and names every other format by reason only', () => {
  assert.equal(classifyPasswordHash(`$2y$10$${'b'.repeat(53)}`).supported, true);
  assert.equal(classifyPasswordHash(`$2a$04$${'b'.repeat(53)}`).supported, true);
  assert.equal(classifyPasswordHash(`$2b$14$${'b'.repeat(53)}`).supported, true);
  assert.deepEqual(classifyPasswordHash(`$2y$15$${'b'.repeat(53)}`), { supported: false, reason: 'bcrypt_cost_out_of_range' });
  assert.deepEqual(classifyPasswordHash(`$2x$10$${'b'.repeat(53)}`), { supported: false, reason: 'bcrypt_variant_unsupported' });
  assert.deepEqual(classifyPasswordHash('$2y$10$short'), { supported: false, reason: 'bcrypt_malformed' });
  assert.equal(classifyPasswordHash('$argon2id$v=19$m=65536').reason, 'argon2');
  assert.equal(classifyPasswordHash('5f4dcc3b5aa765d61d8327deb882cf99').reason, 'unsalted_hex_digest');
  assert.equal(classifyPasswordHash('').reason, 'missing');
  assert.equal(classifyPasswordHash(null).reason, 'missing');
  assert.equal(classifyPasswordHash('hash').reason, 'unrecognized_format');
});

test('deterministic ids are stable, scoped by namespace/tenant/kind and shaped like UUIDs', () => {
  const id = deterministicId('ns', 'tenant-a', 'shift', '17');
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  assert.equal(id, deterministicId('ns', 'tenant-a', 'shift', 17));
  for (const other of [deterministicId('ns2', 'tenant-a', 'shift', '17'), deterministicId('ns', 'tenant-b', 'shift', '17'), deterministicId('ns', 'tenant-a', 'break', '17'), deterministicId('ns', 'tenant-a', 'shift', '18')]) assert.notEqual(other, id);
});

test('exporter helpers decrypt PHP field ciphertext, fall back like PHP, and verify the username hash', () => {
  const key = Buffer.alloc(32, 9);
  const iv = Buffer.alloc(16, 3);
  const cipher = createCipheriv('aes-256-cbc', key, iv);
  const encrypted = Buffer.concat([iv, cipher.update('Dana@Example.test', 'utf8'), cipher.final()]).toString('base64');
  assert.equal(decryptField(encrypted, key), 'Dana@Example.test');
  assert.equal(decryptField('plain.old.row', key), 'plain.old.row');
  assert.equal(decryptField(encrypted, Buffer.alloc(32, 1)) === 'Dana@Example.test', false);
  assert.equal(usernameHash('Dana@Example.test'), sha('dana@example.test'));
  assert.equal(usernameHash('Élan'), sha(Buffer.from('Élan', 'utf8'))); // PHP strtolower is ASCII-only
  assert.throws(() => appKeyFrom('not base64!'), /LEGACY_APP_KEY/);
  assert.throws(() => appKeyFrom(Buffer.alloc(16).toString('base64')), /32 bytes/);
});

test('exporter refuses non-loopback hosts and builds a descriptor the planner accepts', () => {
  assert.doesNotThrow(() => assertScratchHost('127.0.0.1', undefined, {}));
  assert.doesNotThrow(() => assertScratchHost('db.internal', '/run/mysqld/mysqld.sock', {}));
  assert.throws(() => assertScratchHost('db.internal', undefined, {}), /non-loopback/);
  assert.doesNotThrow(() => assertScratchHost('db.internal', undefined, { LEGACY_EXPORT_ALLOW_REMOTE_HOST: 'scratch-copy-confirmed' }));
  assert.throws(() => parseArgs(['--user', 'u']), /Usage/);
  assert.throws(() => parseArgs(['--user', 'u', '--database', 'd', '--out', 'o', '--descriptor-out', 'x'], {}), /--namespace/);
  const src = source(); const bytes = Buffer.from(JSON.stringify(src));
  const descriptor = buildDescriptor({ sourceSha256: sha(bytes), companies: src.companies, namespace: 'unit-v2', targetGeneration: generation, timezone: 'America/Chicago', storeTimezones: { 11: 'America/Los_Angeles' } });
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  const built = buildLegacyImportPlan(bytes, descriptorBytes, { expectedDescriptorSha256: sha(descriptorBytes), expectedSourceSha256: sha(bytes) });
  assert.equal(built.locations.find((location) => location.id === '11').timezone, 'America/Los_Angeles');
  assert.equal(built.locations.find((location) => location.id === '10').timezone, 'America/Chicago');
  assert.throws(() => buildDescriptor({ sourceSha256: sha(bytes), companies: src.companies, namespace: 'x', targetGeneration: generation, timezone: 'America/Chicago' }), /namespace/);
});

test('v2 accounts: linked staff are one person, roles follow the legacy schedule role, unsupported hashes force a reset', () => {
  const built = plan();
  assert.deepEqual(built.counts, { company: 1, location: 2, user: 4, staff: 2 }); // staff 2 (coincident id, no signal) and 9 stay separate
  const byKey = new Map(built.accounts.map((account) => [`${account.sourceType}:${account.id}`, account]));
  assert.equal(byKey.get('user:1').role, 'ADMIN');
  assert.equal(byKey.get('user:1').name, 'Bea Boss'); // linked staff row supplies the display name
  assert.equal(byKey.get('user:1').email, 'boss@example.test');
  assert.equal(byKey.get('user:2').role, 'MANAGER'); // 'schedule' role
  assert.equal(byKey.get('user:3').role, 'STAFF'); // implicit 'store' role alone never makes a manager
  assert.equal(byKey.get('user:4').role, 'STAFF');
  assert.equal(byKey.get('user:3').passwordHash, null);
  assert.equal(byKey.get('user:3').pinResetRequired, true);
  assert.match(byKey.get('user:3').note, /argon2_pin_reset_required/);
  assert.equal(byKey.get('user:1').passwordHash, bcryptY10);
  assert.equal(byKey.get('user:1').pinResetRequired, false);
  assert.equal(byKey.get('staff:2').sourceType, 'staff');
  assert.equal(byKey.get('staff:9').role, 'STAFF');
  assert.deepEqual(built.data.summary.credentials, { preserved: 3, pinResetRequired: 1, reasons: { argon2: 1 } });
  assert.equal(built.data.summary.accounts.unknownRoleAssociations, 1);
  assert.equal(built.adapterVersion, ADAPTER_VERSION_V2);
});

test('v2 schedules: weekly Monday windows in the location zone, positional breaks, counted skips', () => {
  const built = plan();
  const company = built.data.companies[0];
  assert.deepEqual(company.batches.map((batch) => [batch.scheduleKey, batch.weekStart, batch.startTime, batch.endTime, batch.shifts.length]), [
    ['10:2026-03-09', '2026-03-09', '2026-03-09T05:00:00.000Z', '2026-03-16T05:00:00.000Z', 2],
    ['11:2026-03-09', '2026-03-09', '2026-03-09T05:00:00.000Z', '2026-03-16T05:00:00.000Z', 1],
  ]);
  const [first, overnight] = company.batches[0].shifts;
  assert.deepEqual([first.accountKey, first.startTime, first.endTime, first.role], ['user:3', '2026-03-09T14:00:00.000Z', '2026-03-09T22:00:00.000Z', 'Cashier']);
  assert.deepEqual(first.breaks.map((item) => [item.type, item.paid, item.startTime, item.endTime]), [
    ['BREAK1', true, '2026-03-09T16:00:00.000Z', '2026-03-09T16:10:00.000Z'],
    ['LUNCH', false, '2026-03-09T18:00:00.000Z', '2026-03-09T18:30:00.000Z'],
  ]);
  // Sunday night shift belongs to the week of its start; its 1:00 AM column lunch falls on Monday morning.
  assert.deepEqual([overnight.startTime, overnight.endTime], ['2026-03-16T03:00:00.000Z', '2026-03-16T11:00:00.000Z']);
  assert.deepEqual(overnight.breaks.map((item) => [item.type, item.startTime]), [['LUNCH', '2026-03-16T06:00:00.000Z']]);
  const open = company.batches[1].shifts[0];
  assert.deepEqual([open.accountKey, open.role, open.startTime], [null, null, '2026-03-10T18:00:00.000Z']);
  const { summary } = built.data;
  assert.deepEqual([summary.schedules, summary.shifts, summary.breaks, summary.unassignedShifts, summary.skills], [2, 3, 3, 1, 3]);
  assert.deepEqual(summary.shiftsSkipped, { shift_hours_unparseable: 1, shift_date_invalid: 1 });
  assert.deepEqual(summary.configSkipped, { schedule_template_not_assigned_to_a_company: 1 });
  assert.deepEqual(summary.skippedTables, { audit_logs: 4 });
  assert.deepEqual(company.skills.map((item) => [item.accountKey, item.skill]), [['staff:9', 'Floor'], ['user:3', 'Cashier'], ['user:3', 'Grill']]);
  assert.deepEqual(company.documents.map((doc) => doc.key), ['legacy.settings.v1', 'legacy.break_templates.v1', 'legacy.staff_profiles.v1']);
});

test('v2 planning applies the per-person overlap policy and the break rules without losing shifts', () => {
  const src = source({
    shifts: [
      { id: 1, staff_id: 3, store_id: 10, date: '2026-03-10', shift_hours: '9:00 AM-5:00 PM', breaks: [{ start: '10:00 AM', duration: 10 }, { start: '10:05 AM', duration: 10 }, { start: '11:00 PM', duration: 10 }, { start: '12:00 PM', duration: 10 }, { start: '1:00 PM', duration: 10 }, { start: '3:00 PM', duration: 10 }, { start: '4:00 PM', duration: 10 }] },
      { id: 2, staff_id: 3, store_id: 10, date: '2026-03-10', shift_hours: '9:00 AM-5:00 PM' },
      { id: 3, staff_id: 3, store_id: 11, date: '2026-03-10', shift_hours: '4:00 PM-8:00 PM' },
      { id: 4, staff_id: 3, store_id: 10, date: '2026-03-10', shift_hours: '5:00 PM-9:00 PM' },
      { id: 5, staff_id: null, store_id: 10, date: '2026-03-11', shift_hours: '9:00 AM-5:00 PM', break1: 'noonish', break1_duration: '10', lunch: '12:00 PM', lunch_duration: '0', break2: '3:00 PM', break2_duration: '10' },
    ],
  });
  const built = plan(src);
  const all = built.data.companies[0].batches.flatMap((batch) => batch.shifts);
  assert.equal(all.length, 4); // exact duplicate (id 2) dropped
  assert.deepEqual(all.map((shift) => [shift.legacyId, shift.accountKey === null]).sort(), [['1', false], ['3', true], ['4', false], ['5', true]]); // overlap unassigned, adjacent kept
  assert.match(all.find((shift) => shift.legacyId === '3').notes, /overlapped another shift/);
  assert.deepEqual(built.data.summary.shiftsSkipped, { shift_exact_duplicate_dropped: 1, shift_overlap_unassigned: 1 });
  // shift 1 slots: 0 ok, 1 overlaps slot 0, 2 outside the shift (11 PM), 3-6 beyond the three legacy slots; shift 5: unparseable time and zero duration, break2 kept
  assert.deepEqual(all.find((shift) => shift.legacyId === '1').breaks.map((item) => item.type), ['BREAK1']);
  assert.deepEqual(all.find((shift) => shift.legacyId === '5').breaks.map((item) => item.type), ['BREAK2']);
  assert.deepEqual(built.data.summary.breaksSkipped, { break_overlap_or_duplicate_slot: 1, break_outside_shift: 1, break_extra_slot: 4, break_time_unparseable: 1, break_duration_invalid: 1 });
});

test('v2 batches shifts, validates optional descriptor fields and never leaks personal data into the summary', () => {
  const shifts = Array.from({ length: SHIFT_BATCH_SIZE * 2 + 5 }, (_, index) => ({ id: index + 1, staff_id: null, store_id: 10, date: '2026-03-10', shift_hours: '9:00 AM-5:00 PM' }));
  const built = plan(source({ shifts }));
  assert.deepEqual(built.data.companies[0].batches.map((batch) => [batch.createSchedule, batch.shifts.length]), [[true, SHIFT_BATCH_SIZE], [false, SHIFT_BATCH_SIZE], [false, 5]]);
  const withTemplates = plan(source(), { scheduleTemplateCompanyIds: ['1'], storeTimezones: { 11: 'America/Los_Angeles' } });
  assert.deepEqual(withTemplates.data.companies[0].documents.map((doc) => doc.key), ['legacy.settings.v1', 'legacy.break_templates.v1', 'legacy.schedule_templates.v1', 'legacy.staff_profiles.v1']);
  assert.equal(withTemplates.data.companies[0].batches[1].shifts[0].startTime, '2026-03-10T20:00:00.000Z'); // 1 PM PDT
  assert.throws(() => plan(source(), { storeTimezones: { 99: 'America/Chicago' } }), /unknown store/);
  assert.throws(() => plan(source(), { storeTimezones: { 11: 'Mars/Olympus' } }), /store timezone/);
  assert.throws(() => plan(source(), { scheduleTemplateCompanyIds: ['7'] }), /known companies/);
  assert.throws(() => plan(source(), { surprise: true }), /unsupported or missing fields/);
  assert.throws(() => plan(source(), { limits: { ...V2_LIMIT_MAXIMA, maxBytes: V2_LIMIT_MAXIMA.maxBytes + 1 } }), /outside policy bounds/);
  assert.throws(() => plan(source({ format: 'legacy-combined-v1' })), /format/);
  assert.throws(() => plan({ ...source(), extra: [] }), /unsupported or missing fields/);
  const text = JSON.stringify(built.data.summary);
  for (const secret of ['Boss', 'boss@example.test', 'Walt', 'Nolan', 'worker', bcryptY10]) assert.equal(text.includes(secret), false, secret);
});

test('a v1 descriptor still refuses a v2 export and v1 limits remain at v1 bounds', () => {
  const src = source(); const bytes = Buffer.from(JSON.stringify(src));
  const descriptor = { schemaVersion: 1, namespace: 'unit-v1', targetGenerationId: generation, sourceSha256: sha(bytes), adapterVersion: 'legacy-combined-v1', rolePlanSha256: ROLE_PLAN_SHA256, companySlugs: { 1: 'legacy-company-1' }, timezone: 'America/Chicago', limits: { ...V2_LIMIT_MAXIMA } };
  const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
  assert.throws(() => buildLegacyImportPlan(bytes, descriptorBytes, { expectedDescriptorSha256: sha(descriptorBytes), expectedSourceSha256: sha(bytes) }), /outside policy bounds|unsupported or missing fields/);
});

test('the CLI --plan-only mode admits the exact inputs and prints counts without a database or report', async () => {
  const { mkdtempSync, writeFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { main } = await import('../../scripts/import-legacy-users.mjs');
  const directory = mkdtempSync(join(tmpdir(), 'll-plan-only-'));
  try {
    const src = source(); const bytes = Buffer.from(JSON.stringify(src));
    const descriptor = buildDescriptor({ sourceSha256: sha(bytes), companies: src.companies, namespace: 'unit-plan-only', targetGeneration: generation, timezone: 'America/Chicago' });
    const descriptorBytes = Buffer.from(JSON.stringify(descriptor));
    writeFileSync(join(directory, 'export.json'), bytes); writeFileSync(join(directory, 'descriptor.json'), descriptorBytes);
    const env = { DATA_TARGET_ENV: 'test', DATABASE_URL: 'postgresql://nobody:none@127.0.0.1:1/never', LEGACY_IMPORT_DESCRIPTOR_SHA256: sha(descriptorBytes), LEGACY_SOURCE_EXPORT_SHA256: sha(bytes) };
    const result = await main([join(directory, 'export.json'), '--descriptor', join(directory, 'descriptor.json'), '--plan-only'], env);
    assert.equal(result.planOnly, true);
    assert.deepEqual(result.counts, { company: 1, location: 2, user: 4, staff: 2 });
    assert.equal(result.data.shifts, 3);
    assert.equal(result.adapterVersion, ADAPTER_VERSION_V2);
    await assert.rejects(main([join(directory, 'export.json'), '--descriptor', join(directory, 'descriptor.json'), '--plan-only'], { ...env, LEGACY_SOURCE_EXPORT_SHA256: 'f'.repeat(64) }), /source does not match admitted digest/);
    await assert.rejects(main([join(directory, 'export.json'), '--descriptor', join(directory, 'descriptor.json'), '--plan-only', '--report-only'], env), /Unsupported, repeated or incomplete/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
