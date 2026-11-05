// Synthetic-but-realistic data for the legacy PHP/MySQL schema (old/scripts/schema.sql).
// Everything is fabricated (example.* domains, invented names); output is
// deterministic for a given APP_KEY. The generator mirrors how the PHP code writes
// rows: encrypted usernames/names (src/crypto.php), SHA-256 username hashes, a staff
// row sharing the user's id for staff-role and admin users (saveUser), shift_hours
// as "9:00 AM-5:00 PM", and break times as "10:30 AM" in JSON or the legacy columns.
import crypto from 'node:crypto';
import bcrypt from 'bcryptjs';

export const FIXTURE_TIMEZONE = 'America/Chicago';
export const FIXTURE_STORE_TIMEZONES = { 5: 'America/Los_Angeles' };
export const FIXTURE_FIRST_MONDAY = '2026-03-02';
export const FIXTURE_WEEKS = 5;

function prng(seed) { let a = seed >>> 0; return () => { a = (a + 0x6d2b79f5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }
const sha256 = (value) => crypto.createHash('sha256').update(value).digest('hex');
function encryptField(plain, key) {
  const iv = crypto.createHash('sha256').update(`iv:${plain}`).digest().subarray(0, 16);
  const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
  return Buffer.concat([iv, cipher.update(plain, 'utf8'), cipher.final()]).toString('base64');
}
const sql = (value) => {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') return String(value);
  return `'${String(value).replaceAll('\\', '\\\\').replaceAll("'", "''")}'`;
};
function insert(table, rows) {
  if (!rows.length) return '';
  const columns = [...new Set(rows.flatMap((row) => Object.keys(row)))];
  const batches = [];
  for (let offset = 0; offset < rows.length; offset += 200) {
    const values = rows.slice(offset, offset + 200).map((row) => `(${columns.map((c) => (row[c] === undefined ? 'DEFAULT' : sql(row[c]))).join(', ')})`);
    batches.push(`INSERT INTO ${table} (${columns.map((c) => `\`${c}\``).join(', ')}) VALUES ${values.join(',\n')};`);
  }
  return batches.join('\n');
}
const clock = (minutes) => { const m = ((minutes % 1440) + 1440) % 1440; const h24 = Math.floor(m / 60); return `${h24 % 12 || 12}:${String(m % 60).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`; };
const addDays = (date, days) => { const d = new Date(`${date}T00:00:00Z`); d.setUTCDate(d.getUTCDate() + days); return d.toISOString().slice(0, 10); };

const FIRST = ['Avery', 'Blake', 'Casey', 'Dana', 'Eli', 'Finn', 'Gray', 'Harper', 'Indy', 'Jules', 'Kai', 'Lane', 'Morgan', 'Noel', 'Oakley', 'Parker', 'Quinn', 'Reese', 'Sage', 'Tatum', 'Uma', 'Vale', 'Wren', 'Xan', 'Yael', 'Zion', 'Ari', 'Bryn', 'Cleo', 'Drew'];
const LAST = ['Whitfield', 'Okafor', 'Lindqvist', 'Marsh', 'Delgado', 'Haas', 'Ibarra', 'Joubert', 'Kowalski', 'Laurent', 'Mbeki', 'Novak', 'Ostrowski', 'Prieto', 'Quint'];

export function buildLegacyFixture({ appKey }) {
  const key = Buffer.isBuffer(appKey) ? appKey : Buffer.from(appKey, 'base64');
  const rand = prng(20260302);
  const companies = [{ id: 1, name: 'Alder Foods Group' }, { id: 2, name: 'Birch Hardware' }, { id: 3, name: 'Cedar Cafe' }];
  const domains = { 1: 'alder.example', 2: 'birch.example', 3: 'cedar.example' };
  const stores = [
    { id: 1, company_id: 1, name: 'Alder Downtown', location: '100 Main Street' }, { id: 2, company_id: 1, name: 'Alder Airport', location: 'Terminal B' },
    { id: 3, company_id: 2, name: 'Birch Main', location: '45 Oak Avenue' }, { id: 4, company_id: 2, name: 'Birch Annex', location: null },
    { id: 5, company_id: 3, name: 'Cedar Harbor', location: '9 Pier Road' },
  ];
  const storeCompany = new Map(stores.map((s) => [s.id, s.company_id]));
  const names = new Map(); const usedEmails = new Set();
  const nameOf = (id) => `${FIRST[id % FIRST.length]} ${LAST[(id * 7) % LAST.length]}`;

  // id -> [company, home store, kind]
  const plan = [];
  plan[1] = [1, 1, 'super']; plan[2] = [1, 1, 'admin']; plan[3] = [2, 3, 'admin']; plan[4] = [3, 5, 'admin'];
  plan[5] = [1, 1, 'manager']; plan[6] = [1, 2, 'manager-nostaff']; plan[7] = [2, 3, 'manager']; plan[8] = [3, 5, 'manager'];
  const staffHomes = { 9: [1, 1], 10: [1, 1], 11: [1, 1], 12: [1, 1], 13: [1, 2], 14: [1, 2], 15: [1, 2], 16: [1, 2], 17: [2, 3], 18: [2, 3], 19: [2, 3], 20: [2, 4], 21: [2, 4], 22: [3, 5], 23: [3, 5], 24: [3, 5], 27: [1, 1], 28: [1, 2], 29: [2, 3], 30: [3, 5] };
  for (const [id, [c, s]] of Object.entries(staffHomes)) plan[Number(id)] = [c, s, 'staff'];
  plan[25] = [1, 1, 'viewer']; plan[26] = [2, 3, 'viewer'];

  const passwords = {}; const users = []; const userCompanyRoles = []; const userStoreRoles = [];
  const unsupported = { 27: '$argon2id$v=19$m=65536,t=4,p=1$c29tZXNhbHQ$RdescudvJCsgt3ub+b+dWRWJTmaaJObG', 28: '5f4dcc3b5aa765d61d8327deb882cf99', 29: `$2y$15$${'a'.repeat(53)}`, 30: 'hash' };
  for (let id = 1; id <= 30; id += 1) {
    const [companyId, home, kind] = plan[id];
    let fullName = nameOf(id); const [first, last] = fullName.split(' ');
    let email = `${first}.${last}@${domains[companyId]}`.toLowerCase();
    if (usedEmails.has(email)) email = `${first}.${last}${id}@${domains[companyId]}`.toLowerCase();
    usedEmails.add(email);
    names.set(id, fullName);
    const display = id === 9 ? `${first}.${last}@${domains[companyId]}`.replace(/^./, (c) => c.toUpperCase()) : email; // mixed case on purpose
    const password = `Pw-${id}-Lunch!`;
    passwords[id] = password;
    let hash = unsupported[id];
    if (!hash) { const salt = `$2a$10$${sha256(`salt${id}`).slice(0, 22).replace(/[^./A-Za-z0-9]/g, 'x')}`; hash = bcrypt.hashSync(password, salt).replace(/^\$2a\$/, '$2y$'); }
    const plaintextLegacy = id === 25; // an older row written before field encryption
    users.push({ id, company_id: companyId, username: plaintextLegacy ? display : encryptField(display, key), usernameHash: sha256(display.toLowerCase()), password_hash: hash, locked_until: id === 26 ? '2026-04-01 00:00:00' : null, home_store_id: home });
    userStoreRoles.push({ user_id: id, store_id: home, role: 'store' });
    if (kind === 'super') userCompanyRoles.push({ user_id: id, company_id: companyId, role: 'super_admin' });
    if (kind === 'admin' || kind === 'super') userCompanyRoles.push({ user_id: id, company_id: companyId, role: 'company_admin' });
    if (kind === 'manager' || kind === 'manager-nostaff' || kind === 'admin' || kind === 'super') userStoreRoles.push({ user_id: id, store_id: home, role: 'schedule' });
    if (kind === 'staff' || kind === 'manager' || kind === 'super' || kind === 'admin') userStoreRoles.push({ user_id: id, store_id: home, role: 'staff' });
    if (id === 14) userStoreRoles.push({ user_id: id, store_id: home, role: 'chores' });
  }
  // super/admin/manager users are staff-linked (isStaff || isAdmin in saveUser) except 6 and the viewers
  const staff = [];
  const staffNameOf = new Map();
  for (let id = 1; id <= 30; id += 1) {
    const kind = plan[id][2];
    if (kind === 'manager-nostaff' || kind === 'viewer') continue;
    const name = names.get(id); staffNameOf.set(id, name);
    staff.push({ id, store_id: plan[id][1], company_id: plan[id][0], name: encryptField(name, key), lunch_duration: [30, 45, 60][id % 3], pos: id % 4 === 0 ? JSON.stringify(['Cashier', 'Grill']) : id % 4 === 1 ? JSON.stringify(['Register 2']) : null, tasks: id % 5 === 0 ? JSON.stringify([1, 'Prep']) : '[]', is_admin: kind === 'admin' || kind === 'super' ? 1 : 0 });
  }
  // staff id 6 exists with NO login: a coincidental id match with manager user 6 (stays separate)
  staff.push({ id: 6, store_id: 2, company_id: 1, name: encryptField('Coincidence Casey', key), lunch_duration: 30, pos: null, tasks: null, is_admin: 0 });
  const staffOnly = [[31, 1, 1, 'Pat Lee'], [32, 1, 1, 'Pat Lee'], [33, 2, 1, 'Robin Vasquez'], [34, 2, 1, 'Sam Oduya'], [35, 1, 1, "Jo O'Brien"], [36, 3, 2, 'Taylor Brandt'], [37, 3, 2, 'Uli Nakamura'], [38, 4, 2, 'Val Rousseau'], [39, 4, 2, 'Wes Andrade'], [40, 5, 3, 'Xia Petrov'], [41, 5, 3, 'Yusuf Demir'], [42, 5, 3, 'Zora Keane']];
  for (const [id, storeId, companyId, name] of staffOnly) staff.push({ id, store_id: storeId, company_id: companyId, name: id === 42 ? name : encryptField(name, key), lunch_duration: 30, pos: JSON.stringify(['Floor']), tasks: '[]', is_admin: 0 });
  staff.sort((a, b) => a.id - b.id);

  // ---- shifts ---------------------------------------------------------------------
  const shifts = []; const golden = { shiftsByLabel: {}, passwords, expectedSkips: {} };
  let shiftId = 0;
  const reserved = new Set(); // "staffId|date" handled by hand-written rows below
  const handmade = [];
  const addShift = (label, row) => { shiftId += 1; const full = { id: shiftId, staff_id: null, store_id: 1, date: null, shift_hours: '', pos: null, break1: null, break1_duration: null, lunch: null, lunch_duration: null, break2: null, break2_duration: null, breaks: null, tasks: null, sign_off: null, ...row }; shifts.push(full); if (label) golden.shiftsByLabel[label] = full.id; return full; };
  const hand = (label, row) => { reserved.add(`${row.staff_id}|${row.date}`); handmade.push([label, row]); };
  const br = (b1, d1, l, dl, b2, d2) => JSON.stringify([{ start: clock(b1), duration: d1 }, { start: clock(l), duration: dl }, { start: clock(b2), duration: d2 }]);
  hand('springForwardBefore', { staff_id: 9, store_id: 1, date: '2026-03-06', shift_hours: '8:00 AM-4:00 PM', pos: 'Cashier', breaks: br(600, 10, 720, 30, 840, 10) });
  hand('springForwardAfter', { staff_id: 9, store_id: 1, date: '2026-03-09', shift_hours: '8:00 AM-4:00 PM', pos: 'Cashier', breaks: br(600, 10, 720, 30, 840, 10), tasks: JSON.stringify(['Open register', 7]), sign_off: 'Avery' });
  hand('overnightAcrossDst', { staff_id: 10, store_id: 1, date: '2026-03-07', shift_hours: '10:00 PM-6:00 AM', pos: 'Closer', breaks: JSON.stringify([{ start: '12:15 AM', duration: 10 }, { start: '1:30 AM', duration: 30 }, { start: '4:00 AM', duration: 10 }]) });
  hand('pacificStore', { staff_id: 22, store_id: 5, date: '2026-03-10', shift_hours: '9:00 AM-5:00 PM', pos: 'Barista', break1: '11:00 AM', break1_duration: '10', lunch: '1:00 PM', lunch_duration: '30', break2: '3:00 PM', break2_duration: '10' });
  hand('overlapKept', { staff_id: 11, store_id: 1, date: '2026-03-11', shift_hours: '9:00 AM-5:00 PM', pos: 'Host' });
  hand('overlapUnassigned', { staff_id: 11, store_id: 1, date: '2026-03-11', shift_hours: '1:00 PM-9:00 PM', pos: 'Host' });
  hand('duplicateKept', { staff_id: 12, store_id: 1, date: '2026-03-12', shift_hours: '9:00 AM-5:00 PM', pos: 'Host' });
  hand('duplicateDropped', { staff_id: 12, store_id: 1, date: '2026-03-12', shift_hours: '9:00 AM-5:00 PM', pos: 'Host' });
  hand('unparseableHours', { staff_id: 13, store_id: 2, date: '2026-03-12', shift_hours: 'OFF' });
  hand('openShift', { staff_id: null, store_id: 1, date: '2026-03-12', shift_hours: '11:00 AM-3:00 PM', pos: 'Float' });
  hand('breakOutsideShift', { staff_id: 14, store_id: 2, date: '2026-03-13', shift_hours: '9:00 AM-5:00 PM', breaks: JSON.stringify([{ start: '10:30 AM', duration: 10 }, { start: '11:00 PM', duration: 30 }]) });
  hand('lunchColumnOnly', { staff_id: 15, store_id: 2, date: '2026-03-13', shift_hours: '9:00 AM-5:00 PM', break1: '', break1_duration: '', lunch: '12:30 PM', lunch_duration: '45', break2: '', break2_duration: '' });
  hand('linkedAdminShift', { staff_id: 2, store_id: 1, date: '2026-03-14', shift_hours: '9:00 AM-1:00 PM', pos: 'Manager' });
  hand('coincidenceStaffShift', { staff_id: 6, store_id: 2, date: '2026-03-14', shift_hours: '2:00 PM-10:00 PM' });
  for (const [label, row] of handmade) addShift(label, row);

  const variants = [[540, 1020], [600, 1080], [420, 900], [900, 1380], [1320, 1800]];
  const byStore = new Map(); for (const person of staff) { if (person.store_id) { const list = byStore.get(person.store_id) ?? []; list.push(person.id); byStore.set(person.store_id, list); } }
  for (let week = 0; week < FIXTURE_WEEKS; week += 1) {
    for (const store of stores) {
      for (const staffId of byStore.get(store.id) ?? []) {
        if (staffId === 1) continue;
        for (let day = 0; day < 7; day += 1) {
          if ((staffId + day + week) % 7 >= 5) continue; // 5 working days of 7
          const date = addDays(FIXTURE_FIRST_MONDAY, week * 7 + day);
          if (reserved.has(`${staffId}|${date}`)) continue;
          const variant = variants[(staffId + day) % (staffId % 3 === 0 ? 5 : 4)];
          const [start, end] = variant; const hours = `${clock(start)}-${clock(end % 1440 === 0 ? 1440 : end)}`;
          const length = end - start;
          const b = [start + 120, 10, start + 240, [30, 45, 60][staffId % 3], start + length - 120, 10];
          const useJson = (staffId + day) % 2 === 0;
          const row = { staff_id: staffId, store_id: store.id, date, shift_hours: hours, pos: staffId % 2 ? 'Cashier' : 'Prep' };
          if (length >= 360) {
            if (useJson) row.breaks = br(...b); else Object.assign(row, { break1: clock(b[0]), break1_duration: String(b[1]), lunch: clock(b[2]), lunch_duration: String(b[3]), break2: clock(b[4]), break2_duration: String(b[5]) });
          }
          if (rand() < 0.05) row.sign_off = names.get(staffId)?.split(' ')[0] ?? null;
          addShift(null, row);
        }
      }
    }
  }
  golden.shiftRowCount = shifts.length;

  // ---- configuration tables --------------------------------------------------------
  const breakTemplates = [{ company_id: 1, name: 'Closing Crew', break1_offset: 2, break1_duration: 10, lunch_offset: 4, lunch_duration: 45, break2_offset: 1, break2_duration: 15 }, { company_id: 2, name: 'Default', break1_offset: 3, break1_duration: 15, lunch_offset: 4, lunch_duration: 30, break2_offset: 2, break2_duration: 10 }];
  const scheduleTemplates = [{ name: 'Weekend Standard', payload: JSON.stringify({ days: ['sat', 'sun'], shifts: [{ hours: '9:00 AM-5:00 PM', pos: 'Cashier' }] }) }, { name: 'Holiday Reduced', payload: JSON.stringify({ days: ['mon'], shifts: [] }) }];
  const settings = [
    { scope: 'global', store_id: null, company_id: null, name: 'lunch_window_start', value: '11:00' },
    { scope: 'company', store_id: null, company_id: 1, name: 'automation_templates', value: JSON.stringify([{ name: 'Close', chores: [1] }]) },
    { scope: 'store', store_id: 1, company_id: 1, name: 'break_max_concurrent', value: '2' },
    { scope: 'store', store_id: 1, company_id: 1, name: 'lunch_window_end', value: '14:00' },
    { scope: 'store', store_id: 3, company_id: 2, name: 'break_min_spacing', value: '30' },
  ];
  const chores = [
    { store_id: 1, name: 'Clean fryer', instructions: 'Drain and wipe down.', is_active: 1, priority: 2, auto_assign_enabled: 1, frequency: 'daily', recurrence_interval: 1, active_days: 'mon,tue,wed,thu,fri', window_start: '20:00:00', window_end: '22:00:00', daypart: 'close', exclude_closer: 0, exclude_opener: 1, assigned_to: 9, created_by: 2 },
    { store_id: 3, name: 'Restock aisle 4', instructions: null, is_active: 1, priority: 0, auto_assign_enabled: 1, frequency: 'weekly', recurrence_interval: 1, active_days: 'mon,wed', daypart: 'open', assigned_to: null, created_by: 3 },
    { store_id: 5, name: 'Open register', instructions: 'Count the till.', is_active: 0, priority: 1, auto_assign_enabled: 0, frequency: 'per_shift', recurrence_interval: 1, active_days: null, deadline_time: '08:00:00', assigned_to: 22, created_by: 4 },
  ];
  const auditLogs = [{ user_id: 2, company_id: 1, action: 'save', entity: 'staff', entity_id: 9 }, { user_id: 3, company_id: 2, action: 'save', entity: 'schedule', entity_id: 3 }, { user_id: 4, company_id: 3, action: 'clear', entity: 'schedule', entity_id: 5 }];
  const mailQueue = [{ username: 'pending.invite@alder.example', store_id: 1, role: 'staff', template: 'invitation.txt', status: 'pending' }, { username: 'sent.invite@birch.example', store_id: 3, role: 'schedule', template: 'invitation.txt', status: 'sent' }];

  const statements = [
    'SET NAMES utf8mb4;', 'SET FOREIGN_KEY_CHECKS=0;', 'SET time_zone = \'+00:00\';',
    insert('companies', companies), insert('stores', stores), insert('users', users),
    insert('user_company_roles', userCompanyRoles), insert('user_store_roles', userStoreRoles), insert('staff', staff),
    insert('shifts', shifts.map((s) => ({ ...s }))),
    insert('break_templates', breakTemplates), insert('schedule_templates', scheduleTemplates), insert('settings', settings), insert('chores', chores),
    insert('audit_logs', auditLogs), insert('mail_queue', mailQueue),
    insert('password_resets', [{ user_id: 5, token: 'f'.repeat(32), expires_at: '2030-01-01 00:00:00' }]),
    insert('login_attempts', [{ user_id: 5, ip: '203.0.113.9', attempts: 2 }]),
    'SET FOREIGN_KEY_CHECKS=1;',
  ].filter(Boolean);
  golden.counts = { companies: companies.length, stores: stores.length, users: users.length, staff: staff.length, shifts: shifts.length, userCompanyRoles: userCompanyRoles.length, userStoreRoles: userStoreRoles.length, breakTemplates: breakTemplates.length + 1, scheduleTemplates: scheduleTemplates.length, settings: settings.length, chores: chores.length, auditLogs: auditLogs.length, mailQueue: mailQueue.length };
  golden.linkedStaff = staff.filter((s) => s.id <= 30 && s.id !== 6 && !['manager-nostaff', 'viewer'].includes(plan[s.id]?.[2])).length;
  golden.staffOnly = staff.length - golden.linkedStaff;
  golden.userNames = Object.fromEntries([...names.entries()]);
  golden.mixedCaseUserId = 9;
  return { sql: `${statements.join('\n')}\n`, golden };
}
