import crypto from 'node:crypto';
import { sha, stable, fail, record, id, text, alias } from './legacy-import-common.mjs';

// legacy-combined-v2: the exporter output for a real LunchLineup PHP/MySQL
// database. Everything here is pure (no database, no clock, no randomness) so a
// plan is a deterministic function of the approved source bytes + descriptor.
export const ADAPTER_VERSION_V2 = 'legacy-combined-v2';
export const SOURCE_FORMAT_V2 = 'legacy-combined-v2';
export const V2_LIMIT_MAXIMA = Object.freeze({ maxBytes: 268435456, maxRowsPerArray: 1000000, maxTotalRows: 2000000, maxStringLength: 2048, usernameCollisionLimit: 100, transactionTimeoutMs: 30000, transactionMaxWaitMs: 5000, maxDurationMs: 3600000 });
export const V2_ARRAYS = Object.freeze(['companies', 'stores', 'users', 'staff', 'user_company_roles', 'user_store_roles', 'shifts', 'break_templates', 'schedule_templates', 'chores', 'settings']);
export const V2_SOURCE_KEYS = Object.freeze(['format', 'skipped_tables', ...V2_ARRAYS]);
export const V2_DESCRIPTOR_OPTIONAL = Object.freeze(['storeTimezones', 'scheduleTemplateCompanyIds']);
export const SHIFT_BATCH_SIZE = 300;
const LEGACY_ROLES = new Set(['super_admin', 'company_admin', 'store', 'staff', 'schedule', 'chores']);
const BREAK_TYPES = ['BREAK1', 'LUNCH', 'BREAK2'];
const MAX_SETTING_VALUE = 1048576;

const bump = (map, key, by = 1) => { map[key] = (map[key] ?? 0) + by; };
const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : typeof value === 'string' && /^-?\d+$/.test(value.trim()) ? Number(value.trim()) : null);
const str = (value, max) => (typeof value === 'string' && value.trim() && value.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value) ? value.trim() : null);

// ---- deterministic identifiers -------------------------------------------------
export function deterministicId(namespace, tenantId, kind, key) {
  const bytes = crypto.createHash('sha256').update(stable(['legacy-import-id-v2', namespace, tenantId, kind, String(key)])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x80;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

// ---- password hashes -----------------------------------------------------------
// The PHP application uses password_hash(PASSWORD_DEFAULT) (bcrypt, $2y$). The new
// login verifier (bcryptjs, $2y$ normalised to $2a$) accepts cost 4-14 only here.
export function classifyPasswordHash(value) {
  if (value === null || value === undefined || value === '') return { supported: false, reason: 'missing' };
  if (typeof value !== 'string' || value.length > 255) return { supported: false, reason: 'malformed' };
  const bcrypt = /^\$(2[abxy]?)\$(\d{2})\$([./A-Za-z0-9]{53})(?![\s\S])/.exec(value);
  if (bcrypt) {
    if (!['2a', '2b', '2y'].includes(bcrypt[1])) return { supported: false, reason: 'bcrypt_variant_unsupported' };
    const cost = Number(bcrypt[2]);
    if (cost < 4 || cost > 14) return { supported: false, reason: 'bcrypt_cost_out_of_range' };
    return { supported: true, reason: null };
  }
  if (/^\$2[abxy]?\$/.test(value)) return { supported: false, reason: 'bcrypt_malformed' };
  if (value.startsWith('$argon2')) return { supported: false, reason: 'argon2' };
  if (/^[0-9a-f]{32,128}(?![\s\S])/i.test(value)) return { supported: false, reason: 'unsalted_hex_digest' };
  return { supported: false, reason: 'unrecognized_format' };
}

// ---- wall-clock handling -------------------------------------------------------
const formatters = new Map();
function zonedParts(ms, timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
    formatters.set(timeZone, formatter);
  }
  const map = new Map(formatter.formatToParts(new Date(ms)).map((part) => [part.type, part.value]));
  return { year: Number(map.get('year')), month: Number(map.get('month')), day: Number(map.get('day')), hour: Number(map.get('hour')) % 24, minute: Number(map.get('minute')), second: Number(map.get('second')) };
}
// Local wall clock (date + minutes after midnight) -> UTC milliseconds. A time
// inside a spring-forward gap resolves forward; an ambiguous fall-back time
// resolves to one fixed instant. Both are deterministic.
export function wallClockToUtc(dateValue, minutes, timeZone) {
  const [year, month, day] = dateValue.split('-').map(Number);
  const target = Date.UTC(year, month - 1, day, 0, 0, 0) + minutes * 60000;
  let guess = target;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    const actual = zonedParts(guess, timeZone);
    const delta = target - Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
    if (delta === 0) break;
    guess += delta;
  }
  return guess;
}
export function validDate(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}(?![\s\S])/.test(value)) return false;
  const [y, m, d] = value.split('-').map(Number);
  const probe = new Date(Date.UTC(y, m - 1, d));
  return y >= 1970 && y <= 2200 && probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}
export function addDays(dateValue, days) {
  const [y, m, d] = dateValue.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d + days));
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}
export function mondayOf(dateValue) {
  const [y, m, d] = dateValue.split('-').map(Number);
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return addDays(dateValue, -((dow + 6) % 7));
}
// Accepts what the PHP normaliseTime() writes ("9:00 AM", "10:30 PM"), plus the
// hand-edited variants the UI allows ("9a", "0900", "13:30", "9 pm").
export function parseClockMinutes(value, { allowEndOfDay = false } = {}) {
  if (typeof value !== 'string') return null;
  const t = value.trim().toUpperCase().replace(/\./g, '').replace(/\s+/g, '');
  let m = /^(\d{1,2})(?::?(\d{2}))?([AP])M?$/.exec(t);
  if (m) {
    const h = Number(m[1]); const min = Number(m[2] ?? 0);
    if (h < 1 || h > 12 || min > 59) return null;
    return ((h % 12) + (m[3] === 'P' ? 12 : 0)) * 60 + min;
  }
  m = /^(\d{1,2}):(\d{2})$/.exec(t) ?? /^(\d{2})(\d{2})$/.exec(t);
  if (m) {
    const h = Number(m[1]); const min = Number(m[2]);
    if (min > 59 || h > 24 || (h === 24 && (min !== 0 || !allowEndOfDay))) return null;
    return h * 60 + min;
  }
  return null;
}
export function parseShiftHours(value) {
  if (typeof value !== 'string') return null;
  const parts = value.split(/\s*(?:-|–|—|\bto\b)\s*/i);
  if (parts.length !== 2) return null;
  const start = parseClockMinutes(parts[0]); const end = parseClockMinutes(parts[1], { allowEndOfDay: true });
  if (start === null || end === null || start === end) return null;
  return { start, end: end > start ? end : end + 1440 };
}

// ---- accounts ------------------------------------------------------------------
export function planAccountsV2({ userRows, staffRows, source, userCompanies, storeCompanies, companyIds, limits }) {
  const summary = { users: userRows.length, linkedStaff: 0, staffOnly: 0, passwordPreserved: 0, pinResetRequired: 0, pinResetReasons: {}, unknownRoleAssociations: 0, staffNameMissing: 0 };
  const roleNames = new Map(); const seen = new Set();
  for (const [array, association] of [['user_company_roles', 'company_id'], ['user_store_roles', 'store_id']]) {
    for (const row of source[array]) {
      record(row, array);
      const userId = id(row.user_id, 'role user_id'); const target = id(row[association], `role ${association}`);
      const companyId = association === 'company_id' ? target : storeCompanies.get(target);
      if (!userCompanies.has(userId) || !companyId || userCompanies.get(userId) !== companyId) fail('role association is absent or crosses company');
      if (typeof row.role !== 'string' || !row.role || row.role.length > 50) fail('role name is invalid');
      const key = stable([array, userId, target, row.role]); if (seen.has(key)) fail('duplicate role association'); seen.add(key);
      if (!LEGACY_ROLES.has(row.role)) summary.unknownRoleAssociations += 1;
      const list = roleNames.get(userId) ?? new Set(); list.add(row.role); roleNames.set(userId, list);
    }
  }
  const adminFlag = (row) => { if (![0, 1, '0', '1', true, false].includes(row.is_admin)) fail('staff is_admin must be exactly 0 or 1'); return Number(row.is_admin) === 1; };
  const staffById = new Map(staffRows.map(({ row, id: staffId }) => [staffId, row]));
  for (const { row } of staffRows) {
    if (!companyIds.has(id(row.company_id, 'staff.company_id'))) fail('staff has unknown company');
    if (row.store_id !== undefined && row.store_id !== null && storeCompanies.get(id(row.store_id, 'staff store_id')) !== id(row.company_id, 'staff company')) fail('staff store is absent or crosses company');
    adminFlag(row);
  }
  const accounts = []; const staffRefs = new Map(); const linked = new Set();
  for (const { row, id: userId } of userRows) {
    const roles = roleNames.get(userId) ?? new Set();
    const companyId = userCompanies.get(userId);
    const staffRow = staffById.get(userId);
    const adminRole = roles.has('company_admin') || roles.has('super_admin');
    // The PHP saveUser() upserts a staff row with the SAME id for staff-role and
    // admin users; a bare id coincidence without those signals stays separate.
    const isLinked = Boolean(staffRow) && id(staffRow.company_id, 'staff.company_id') === companyId && (adminFlag(staffRow) || adminRole || roles.has('staff'));
    if (isLinked) { linked.add(userId); staffRefs.set(userId, `user:${userId}`); summary.linkedStaff += 1; }
    const sourceUsername = text(alias(row, 'username_plain', 'username', `legacy.user.${userId}`), 'username', limits.maxStringLength);
    let name = sourceUsername;
    if (isLinked) { const staffName = alias(staffRow, 'name_plain', 'name', ''); if (typeof staffName === 'string' && staffName.trim() && staffName.length <= limits.maxStringLength) name = staffName; }
    else { const userName = alias(row, 'name_plain', 'name', undefined); if (userName !== undefined) name = text(userName, 'user name', limits.maxStringLength); }
    const credential = classifyPasswordHash(alias(row, 'password_hash', 'passwordHash', null));
    if (credential.supported) summary.passwordPreserved += 1; else { summary.pinResetRequired += 1; bump(summary.pinResetReasons, credential.reason); }
    if (row.home_store_id !== undefined && row.home_store_id !== null && storeCompanies.get(id(row.home_store_id, 'home_store_id')) !== companyId) fail('user home store is absent or crosses company');
    const role = adminRole || (isLinked && adminFlag(staffRow)) ? 'ADMIN' : roles.has('schedule') ? 'MANAGER' : 'STAFF';
    const notes = [roles.has('super_admin') ? 'legacy_super_admin_downgraded_to_tenant_admin' : '', credential.supported ? '' : `legacy_password_${credential.reason}_pin_reset_required`].filter(Boolean);
    accounts.push({
      id: userId, companyId, sourceType: 'user', name, usernameBase: usernameBase(sourceUsername, `legacy.user.${userId}`),
      email: /^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(sourceUsername) ? sourceUsername.toLowerCase() : null,
      passwordHash: credential.supported ? row.password_hash ?? row.passwordHash : null, pinResetRequired: !credential.supported,
      role, note: notes.join(';'), rowSha256: sha(stable(isLinked ? { user: row, staff: staffRow } : row)),
      linkedStaffId: isLinked ? userId : null, staff: isLinked ? staffRow : null,
    });
  }
  for (const { row, id: staffId } of staffRows) {
    if (linked.has(staffId)) continue;
    const companyId = id(row.company_id, 'staff.company_id');
    let name = alias(row, 'name_plain', 'name', '');
    if (typeof name !== 'string' || !name.trim() || name.length > limits.maxStringLength) { name = `Staff ${staffId}`; summary.staffNameMissing += 1; }
    staffRefs.set(staffId, `staff:${staffId}`); summary.staffOnly += 1;
    accounts.push({ id: staffId, companyId, sourceType: 'staff', name, usernameBase: usernameBase(name, `staff.${staffId}`), email: null, passwordHash: null, pinResetRequired: false, role: adminFlag(row) ? 'ADMIN' : 'STAFF', note: '', rowSha256: sha(stable(row)), linkedStaffId: staffId, staff: row });
  }
  return { accounts, staffRefs, summary };
}
function usernameBase(value, fallback) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 48) || fallback; }

// ---- schedules, shifts, breaks -------------------------------------------------
function parseJson(value) {
  if (typeof value !== 'string') return value;
  if (!value.trim()) return null;
  try { return JSON.parse(value); } catch { return undefined; }
}
function taskLabels(value) {
  const parsed = parseJson(value);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter((item) => ['string', 'number'].includes(typeof item) && String(item).trim()).map((item) => String(item).trim().slice(0, 100)).slice(0, 50);
}
function breakEntries(row) {
  const parsed = parseJson(row.breaks);
  if (Array.isArray(parsed) && parsed.length) return parsed.map((entry, slot) => ({ slot, start: entry?.start, duration: entry?.duration }));
  return [['break1', 'break1_duration'], ['lunch', 'lunch_duration'], ['break2', 'break2_duration']].map(([start, duration], slot) => ({ slot, start: row[start], duration: row[duration] }));
}
function planBreaks(row, shiftDate, shiftStartMinutes, startMs, endMs, timeZone, skipped) {
  const result = [];
  for (const entry of breakEntries(row)) {
    if (entry.start === undefined || entry.start === null || (typeof entry.start === 'string' && !entry.start.trim())) continue;
    if (entry.slot > 2) { bump(skipped, 'break_extra_slot'); continue; }
    const clock = parseClockMinutes(String(entry.start));
    if (clock === null || clock >= 1440) { bump(skipped, 'break_time_unparseable'); continue; }
    const duration = num(entry.duration);
    if (duration === null || duration < 1 || duration > 480) { bump(skipped, 'break_duration_invalid'); continue; }
    const start = wallClockToUtc(addDays(shiftDate, clock >= shiftStartMinutes ? 0 : 1), clock, timeZone);
    const end = start + duration * 60000;
    if (start < startMs || end > endMs) { bump(skipped, 'break_outside_shift'); continue; }
    result.push({ slot: entry.slot, type: BREAK_TYPES[entry.slot], paid: entry.slot !== 1, start, end });
  }
  const kept = [];
  for (const candidate of result.sort((a, b) => a.start - b.start || a.slot - b.slot)) {
    if (kept.some((other) => candidate.start < other.end && other.start < candidate.end || other.slot === candidate.slot)) { bump(skipped, 'break_overlap_or_duplicate_slot'); continue; }
    kept.push(candidate);
  }
  return kept.map((item) => ({ slot: item.slot, type: item.type, paid: item.paid, startTime: new Date(item.start).toISOString(), endTime: new Date(item.end).toISOString() }));
}

function planShifts({ source, locations, locationsByStore, accountsByRef, staffRefs, timezoneOf }) {
  const skipped = {}; const candidates = [];
  const seen = new Set();
  for (const row of source.shifts) {
    record(row, 'shifts row');
    const shiftId = id(row.id, 'shifts.id'); if (seen.has(shiftId)) fail('duplicate shifts identity'); seen.add(shiftId);
    const storeId = id(row.store_id, 'shifts.store_id');
    const location = locationsByStore.get(storeId);
    if (!location) { bump(skipped, 'shift_unknown_store'); continue; }
    let accountKey = null;
    if (row.staff_id !== null && row.staff_id !== undefined) {
      accountKey = staffRefs.get(id(row.staff_id, 'shifts.staff_id')) ?? null;
      if (!accountKey) { bump(skipped, 'shift_unknown_staff'); continue; }
      if (accountsByRef.get(accountKey).companyId !== location.companyId) { bump(skipped, 'shift_cross_company'); continue; }
    }
    if (!validDate(row.date)) { bump(skipped, 'shift_date_invalid'); continue; }
    const hours = parseShiftHours(row.shift_hours);
    if (!hours) { bump(skipped, 'shift_hours_unparseable'); continue; }
    const timeZone = timezoneOf(storeId);
    const startMs = wallClockToUtc(row.date, hours.start, timeZone);
    const endMs = hours.end > 1440 ? wallClockToUtc(addDays(row.date, 1), hours.end - 1440, timeZone) : wallClockToUtc(row.date, hours.end, timeZone);
    if (!(endMs > startMs) || endMs - startMs > 86400000) { bump(skipped, 'shift_window_invalid'); continue; }
    candidates.push({ shiftId, storeId, location, accountKey, date: row.date, startMs, endMs, startMinutes: hours.start, row, timeZone });
  }
  // Per-person overlap policy (same remedy as the in-database legacy repair):
  // an exact duplicate is dropped; any other overlap keeps the shift unassigned.
  const keptEnd = new Map(); const keptWindow = new Set();
  candidates.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs || Number(a.shiftId) - Number(b.shiftId));
  for (const shift of candidates) {
    shift.dropped = false; shift.overlapUnassigned = false;
    if (!shift.accountKey) continue;
    const windowKey = `${shift.accountKey}|${shift.storeId}|${shift.startMs}|${shift.endMs}`;
    if (keptWindow.has(windowKey)) { shift.dropped = true; bump(skipped, 'shift_exact_duplicate_dropped'); continue; }
    if ((keptEnd.get(shift.accountKey) ?? -Infinity) > shift.startMs) { shift.overlapUnassigned = true; bump(skipped, 'shift_overlap_unassigned'); continue; }
    keptWindow.add(windowKey); keptEnd.set(shift.accountKey, shift.endMs);
  }
  const groups = new Map();
  for (const shift of candidates) {
    if (shift.dropped) continue;
    const week = mondayOf(shift.date);
    const key = `${shift.storeId}|${week}`;
    const list = groups.get(key) ?? { location: shift.location, storeId: shift.storeId, week, timeZone: shift.timeZone, shifts: [] };
    list.shifts.push(shift); groups.set(key, list);
  }
  const breakSkips = {}; let breakCount = 0; let shiftCount = 0; let unassigned = 0;
  const schedulesByCompany = new Map();
  for (const group of [...groups.values()].sort((a, b) => Number(a.storeId) - Number(b.storeId) || a.week.localeCompare(b.week))) {
    const startMs = wallClockToUtc(group.week, 0, group.timeZone); const endMs = wallClockToUtc(addDays(group.week, 7), 0, group.timeZone);
    const scheduleKey = `${group.storeId}:${group.week}`;
    const shifts = group.shifts.sort((a, b) => a.startMs - b.startMs || Number(a.shiftId) - Number(b.shiftId)).map((shift) => {
      const row = shift.row;
      const notes = [];
      const tasks = taskLabels(row.tasks); if (tasks.length) notes.push(`Tasks: ${tasks.join(', ')}`);
      const signOff = str(row.sign_off, 255); if (signOff) notes.push(`Sign-off: ${signOff}`);
      if (shift.overlapUnassigned) notes.push(`Imported unassigned: overlapped another shift for the same staff member (legacy staff #${row.staff_id}).`);
      const breaks = planBreaks(row, shift.date, shift.startMinutes, shift.startMs, shift.endMs, shift.timeZone, breakSkips);
      breakCount += breaks.length; shiftCount += 1;
      const accountKey = shift.overlapUnassigned ? null : shift.accountKey; if (!accountKey) unassigned += 1;
      return { legacyId: shift.shiftId, accountKey, startTime: new Date(shift.startMs).toISOString(), endTime: new Date(shift.endMs).toISOString(), role: str(row.pos, 255), notes: notes.length ? notes.join('\n').slice(0, 2000) : null, breaks };
    });
    const list = schedulesByCompany.get(group.location.companyId) ?? [];
    for (let offset = 0; offset < shifts.length; offset += SHIFT_BATCH_SIZE) {
      list.push({ scheduleKey, locationLegacyId: group.storeId, weekStart: group.week, startTime: new Date(startMs).toISOString(), endTime: new Date(endMs).toISOString(), createSchedule: offset === 0, shifts: shifts.slice(offset, offset + SHIFT_BATCH_SIZE) });
    }
    schedulesByCompany.set(group.location.companyId, list);
  }
  const scheduleCount = [...groups.values()].length;
  return { schedulesByCompany, scheduleCount, shiftCount, breakCount, unassigned, shiftSkipped: skipped, breakSkipped: breakSkips };
}

// ---- configuration documents ---------------------------------------------------
const ref = {
  account: (key) => (key ? { $account: key } : null),
  location: (storeId) => (storeId ? { $location: storeId } : null),
};
function planConfig({ source, companies, locations, accountsByRef, staffRefs, templateCompanies, accounts, limits }) {
  const skipped = {};
  const storeCompany = new Map(locations.map((location) => [location.id, location.companyId]));
  const perCompany = new Map(companies.map((company) => [company.id, { global: {}, company: {}, stores: new Map(), breakTemplates: [], defaultBreakTemplate: null, scheduleTemplates: [], chores: [], profiles: [], skills: [] }]));
  const defaults = [];
  for (const row of source.settings) {
    record(row, 'settings row');
    const name = str(row.name, 50); const value = row.value === null || row.value === undefined ? '' : String(row.value);
    if (!name || value.length > MAX_SETTING_VALUE || !['global', 'company', 'store'].includes(row.scope)) { bump(skipped, 'setting_invalid'); continue; }
    if (row.scope === 'global') { for (const entry of perCompany.values()) entry.global[name] = value; continue; }
    if (row.scope === 'company') { const entry = perCompany.get(row.company_id === null ? null : id(row.company_id, 'settings.company_id')); if (entry) entry.company[name] = value; else bump(skipped, 'setting_unknown_company'); continue; }
    const storeId = row.store_id === null || row.store_id === undefined ? null : id(row.store_id, 'settings.store_id');
    const entry = storeId ? perCompany.get(storeCompany.get(storeId)) : null;
    if (!entry) { bump(skipped, 'setting_unknown_store'); continue; }
    const values = entry.stores.get(storeId) ?? {}; values[name] = value; entry.stores.set(storeId, values);
  }
  for (const row of source.break_templates) {
    record(row, 'break_templates row'); const templateId = id(row.id, 'break_templates.id');
    const fields = ['break1_offset', 'break1_duration', 'lunch_offset', 'lunch_duration', 'break2_offset', 'break2_duration'].map((key) => num(row[key]));
    const name = str(row.name, 255);
    if (!name || fields.some((value) => value === null || value < 0 || value > 255)) { bump(skipped, 'break_template_invalid'); continue; }
    const template = { legacyId: templateId, name, break1OffsetHours: fields[0], break1DurationMinutes: fields[1], lunchOffsetHours: fields[2], lunchDurationMinutes: fields[3], break2OffsetHours: fields[4], break2DurationMinutes: fields[5] };
    if (row.company_id === null || row.company_id === undefined) { defaults.push(template); continue; }
    const entry = perCompany.get(id(row.company_id, 'break_templates.company_id'));
    if (entry) entry.breakTemplates.push(template); else bump(skipped, 'break_template_unknown_company');
  }
  for (const row of source.schedule_templates) {
    record(row, 'schedule_templates row'); const templateId = id(row.id, 'schedule_templates.id');
    const name = str(row.name, 255);
    if (!name || typeof row.payload !== 'string' || row.payload.length > MAX_SETTING_VALUE) { bump(skipped, 'schedule_template_invalid'); continue; }
    if (!templateCompanies.length) { bump(skipped, 'schedule_template_not_assigned_to_a_company'); continue; }
    for (const companyId of templateCompanies) perCompany.get(companyId).scheduleTemplates.push({ legacyId: templateId, name, payload: row.payload });
  }
  let choreCount = 0;
  for (const row of source.chores) {
    record(row, 'chores row'); const choreId = id(row.id, 'chores.id'); const storeId = id(row.store_id, 'chores.store_id');
    const entry = perCompany.get(storeCompany.get(storeId));
    if (!entry) { bump(skipped, 'chore_unknown_store'); continue; }
    const assigned = row.assigned_to === null || row.assigned_to === undefined ? null : staffRefs.get(id(row.assigned_to, 'chores.assigned_to')) ?? null;
    const createdBy = row.created_by === null || row.created_by === undefined ? null : (accountsByRef.has(`user:${id(row.created_by, 'chores.created_by')}`) ? `user:${row.created_by}` : null);
    const { id: _id, store_id: _store, assigned_to: _assigned, created_by: _createdBy, created_at: _c, updated_at: _u, ...rest } = row;
    entry.chores.push({ legacyId: choreId, location: ref.location(storeId), assignedTo: ref.account(assigned), createdBy: ref.account(createdBy), fields: rest });
    choreCount += 1;
  }
  let skillCount = 0;
  for (const account of accounts) {
    const entry = perCompany.get(account.companyId); const staff = account.staff;
    if (!staff) continue;
    const parsedPos = parseJson(staff.pos);
    const skills = [...new Set((Array.isArray(parsedPos) ? parsedPos : typeof staff.pos === 'string' && parsedPos === undefined ? [staff.pos] : []).filter((s) => typeof s === 'string').map((s) => s.trim()).filter((s) => s && s.length <= 100))].slice(0, 50);
    for (const skill of skills) { entry.skills.push({ accountKey: `${account.sourceType}:${account.id}`, skill }); skillCount += 1; }
    const lunch = num(staff.lunch_duration);
    const tasks = Array.isArray(parseJson(staff.tasks)) ? parseJson(staff.tasks).filter((item) => ['string', 'number'].includes(typeof item)).slice(0, 100) : [];
    if (lunch !== null || tasks.length || skills.length) entry.profiles.push({ legacyStaffId: String(account.linkedStaffId), account: ref.account(`${account.sourceType}:${account.id}`), lunchDurationMinutes: lunch, preferredPositions: skills, preferredTasks: tasks });
  }
  for (const entry of perCompany.values()) if (defaults.length) entry.defaultBreakTemplate = defaults[0];
  return { perCompany, skipped, choreCount, skillCount, defaultsCount: defaults.length, limits };
}

// ---- top-level data plan -------------------------------------------------------
export function planLegacyData({ sourceSha256, source, companies, locations, accounts, staffRefs, accountSummary, timezone, storeTimezones, templateCompanies, limits }) {
  const accountsByRef = new Map(accounts.map((account) => [`${account.sourceType}:${account.id}`, account]));
  const locationsByStore = new Map(locations.map((location) => [location.id, location]));
  const timezoneOf = (storeId) => storeTimezones[storeId] ?? timezone;
  const shiftPlan = planShifts({ source, locations, locationsByStore, accountsByRef, staffRefs, timezoneOf });
  const config = planConfig({ source, companies, locations, accountsByRef, staffRefs, templateCompanies, accounts, limits });
  const skippedTables = source.skipped_tables ?? {};
  const summary = {
    schedules: shiftPlan.scheduleCount, shifts: shiftPlan.shiftCount, breaks: shiftPlan.breakCount, unassignedShifts: shiftPlan.unassigned,
    skills: config.skillCount, chores: config.choreCount, breakTemplateDefaults: config.defaultsCount,
    shiftsSkipped: shiftPlan.shiftSkipped, breaksSkipped: shiftPlan.breakSkipped, configSkipped: config.skipped,
    credentials: { preserved: accountSummary.passwordPreserved, pinResetRequired: accountSummary.pinResetRequired, reasons: accountSummary.pinResetReasons },
    accounts: { users: accountSummary.users, linkedStaff: accountSummary.linkedStaff, staffOnly: accountSummary.staffOnly, unknownRoleAssociations: accountSummary.unknownRoleAssociations, staffNameMissing: accountSummary.staffNameMissing },
    skippedTables,
  };
  const byCompany = companies.map((company) => {
    const entry = config.perCompany.get(company.id);
    const documents = [];
    const stores = [...entry.stores.entries()].sort((a, b) => Number(a[0]) - Number(b[0])).map(([storeId, values]) => ({ location: ref.location(storeId), legacyStoreId: storeId, values }));
    documents.push({ key: 'legacy.settings.v1', value: { global: entry.global, company: entry.company, stores } });
    documents.push({ key: 'legacy.break_templates.v1', value: { default: entry.defaultBreakTemplate, company: entry.breakTemplates, units: { offsets: 'hours after shift start', durations: 'minutes' } } });
    if (entry.scheduleTemplates.length) documents.push({ key: 'legacy.schedule_templates.v1', value: { templates: entry.scheduleTemplates } });
    if (entry.chores.length) documents.push({ key: 'legacy.chores.v1', value: { chores: entry.chores } });
    if (entry.profiles.length) documents.push({ key: 'legacy.staff_profiles.v1', value: { profiles: entry.profiles } });
    return { companyId: company.id, batches: shiftPlan.schedulesByCompany.get(company.id) ?? [], skills: entry.skills.sort((a, b) => a.accountKey.localeCompare(b.accountKey) || a.skill.localeCompare(b.skill)), documents, provenance: { key: 'legacy-import.data-provenance.v2', value: { version: 2, sourceSha256, summary } } };
  });
  return { companies: byCompany, summary };
}
