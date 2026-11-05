#!/usr/bin/env node
// Read-only exporter: legacy LunchLineup PHP/MySQL (or MariaDB) -> legacy-combined-v2 JSON.
//
//   LEGACY_MYSQL_PASSWORD=... LEGACY_APP_KEY=<base64 APP_KEY of the PHP app> \
//   node scripts/export-legacy-mysql.mjs --host 127.0.0.1 --user ll_export --database lunchlineup_scratch \
//     --out export.json --descriptor-out descriptor.json --namespace acme-cutover-v1 \
//     --target-generation <uuid from legacy_import.target_generation> --timezone America/Chicago
//
// Guarantees: one REPEATABLE READ / READ ONLY / CONSISTENT SNAPSHOT transaction, only
// SELECT statements after session setup, loopback host unless explicitly overridden,
// output created exclusively with mode 0600, and no personal data on stdout/stderr.
import crypto from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { ROLE_PLAN_SHA256 } from './legacy-import-plan.mjs';
import { ADAPTER_VERSION_V2, SOURCE_FORMAT_V2, V2_LIMIT_MAXIMA } from './legacy-import-v2.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const USER_HASH_COLUMNS = ['usernameHash', 'username_hash', 'emailHash', 'email_hash'];
// Tables that are deliberately not exported. Only their row counts are recorded.
export const SKIPPED_TABLES = ['audit_logs', 'mail_queue', 'password_resets', 'login_attempts', 'roles', 'role_permissions', 'chore_required_skills', 'chore_excluded_positions', 'chore_allowed_positions'];
const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// ---- PHP-compatible field decryption (src/crypto.php decryptField) -----------------
export function appKeyFrom(value) {
  if (typeof value !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(value)) throw new Error('LEGACY_APP_KEY must be the base64 APP_KEY of the PHP application');
  const key = Buffer.from(value, 'base64');
  if (key.length !== 32) throw new Error('LEGACY_APP_KEY must decode to exactly 32 bytes');
  return key;
}
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
export function decryptField(value, key) {
  if (typeof value !== 'string') return value;
  if (!BASE64.test(value)) return value;
  const data = Buffer.from(value, 'base64');
  if (data.length < 17) return value;
  try {
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, data.subarray(0, 16));
    const plain = Buffer.concat([decipher.update(data.subarray(16)), decipher.final()]);
    return new TextDecoder('utf-8', { fatal: true }).decode(plain);
  } catch { return value; }
}
const asciiLower = (value) => value.replace(/[A-Z]/g, (c) => c.toLowerCase());
export const usernameHash = (username) => sha256(Buffer.from(asciiLower(username), 'utf8'));
// An undecryptable ciphertext falls back to the stored value (as PHP does); that
// is only legitimate for old plaintext rows, so a long base64-looking leftover is suspect.
const looksEncrypted = (value) => typeof value === 'string' && value.length >= 32 && value.length % 4 === 0 && BASE64.test(value) && !/\s/.test(value);

// ---- connection --------------------------------------------------------------------
function loadMysql() {
  const attempts = [() => createRequire(path.join(here, 'legacy-export', 'package.json'))('mysql2/promise'), () => createRequire(import.meta.url)('mysql2/promise')];
  for (const attempt of attempts) { try { return attempt(); } catch { /* try next */ } }
  throw new Error('mysql2 is not installed. Run: (cd scripts/legacy-export && npm ci)');
}
const LOOPBACK = new Set(['127.0.0.1', '::1', 'localhost']);
export function assertScratchHost(host, socketPath, env) {
  if (socketPath) return;
  if (LOOPBACK.has(host) || env.LEGACY_EXPORT_ALLOW_REMOTE_HOST === 'scratch-copy-confirmed') return;
  throw new Error('Refusing a non-loopback database host. Export from a scratch copy loaded locally (see docs/runbooks/legacy-migration.md); the override is LEGACY_EXPORT_ALLOW_REMOTE_HOST=scratch-copy-confirmed.');
}
export async function openSnapshot(options, env) {
  const mysql = loadMysql();
  assertScratchHost(options.host, options.socketPath, env);
  const connection = await mysql.createConnection({
    host: options.socketPath ? undefined : options.host, port: options.port, socketPath: options.socketPath, user: options.user, password: env.LEGACY_MYSQL_PASSWORD ?? '', database: options.database,
    charset: 'utf8mb4', dateStrings: true, supportBigNumbers: true, bigNumberStrings: true, multipleStatements: false, connectTimeout: 15000,
  });
  // Session setup is the only non-SELECT SQL this tool ever sends.
  await connection.query('SET SESSION TRANSACTION ISOLATION LEVEL REPEATABLE READ');
  await connection.query('SET SESSION TRANSACTION READ ONLY');
  await connection.query('START TRANSACTION WITH CONSISTENT SNAPSHOT');
  const select = async (sql) => {
    if (!/^\s*SELECT\s/i.test(sql) || sql.includes(';')) throw new Error('Exporter attempted a non-SELECT statement');
    const [rows] = await connection.query(sql);
    return rows;
  };
  return { select, async close() { try { await connection.query('ROLLBACK'); } finally { await connection.end(); } } };
}

// ---- export ------------------------------------------------------------------------
const intOrNull = (value) => (value === null || value === undefined ? null : Number(value));
const plainJson = (value) => {
  if (value === null || value === undefined) return null;
  if (typeof value === 'object') return value;
  try { return JSON.parse(value); } catch { return null; }
};
export async function buildExport(select, appKey, { allowHashMismatch = false, allowEncryptedNames = false } = {}) {
  const columnRows = await select('SELECT table_name AS t, column_name AS c FROM information_schema.columns WHERE table_schema = DATABASE()');
  const columns = new Map();
  for (const row of columnRows) { const table = row.t ?? row.TABLE_NAME; const list = columns.get(table) ?? new Set(); list.add(row.c ?? row.COLUMN_NAME); columns.set(table, list); }
  const has = (table, column) => columns.get(table)?.has(column) ?? false;
  for (const table of ['companies', 'stores', 'users', 'staff', 'shifts']) if (!columns.has(table)) throw new Error('Database does not look like a LunchLineup legacy schema');
  const listOf = (table, wanted) => wanted.filter((column) => has(table, column));
  const pick = (table, wanted) => `SELECT ${listOf(table, wanted).map((c) => `\`${c}\``).join(', ')} FROM \`${table}\` ORDER BY \`id\``;
  const optional = async (table, wanted) => (columns.has(table) ? select(pick(table, wanted)) : []);

  const companies = (await select(pick('companies', ['id', 'name']))).map((row) => ({ id: Number(row.id), name: row.name }));
  const stores = (await select(pick('stores', ['id', 'company_id', 'name', 'location']))).map((row) => ({ id: Number(row.id), company_id: Number(row.company_id), name: row.name, location: row.location ?? null }));
  const storeCompany = new Map(stores.map((store) => [store.id, store.company_id]));

  const usernameColumn = ['username', 'email'].find((column) => has('users', column));
  const hashColumn = USER_HASH_COLUMNS.find((column) => has('users', column));
  if (!usernameColumn) throw new Error('users table has no username/email column');
  const passwordColumn = ['password_hash', 'passwordHash'].find((column) => has('users', column));
  const userRows = await select(`SELECT \`id\`, \`${usernameColumn}\` AS u, ${hashColumn ? `\`${hashColumn}\`` : 'NULL'} AS h, ${passwordColumn ? `\`${passwordColumn}\`` : 'NULL'} AS p, ${has('users', 'company_id') ? '`company_id`' : 'NULL'} AS c, ${has('users', 'home_store_id') ? '`home_store_id`' : 'NULL'} AS s FROM \`users\` ORDER BY \`id\``);
  let hashChecked = 0; let hashMismatched = 0;
  const users = userRows.map((row) => {
    const plain = decryptField(row.u, appKey);
    if (row.h) { hashChecked += 1; if (String(row.h).toLowerCase() !== usernameHash(plain)) hashMismatched += 1; }
    const home = intOrNull(row.s);
    return { id: Number(row.id), company_id: row.c === null ? storeCompany.get(home) ?? null : Number(row.c), username_plain: plain, password_hash: row.p ?? null, home_store_id: home };
  });
  if (hashMismatched > 0 && !allowHashMismatch) throw new Error(`Username integrity check failed for ${hashMismatched} of ${hashChecked} users: LEGACY_APP_KEY does not match this database`);
  if (users.some((user) => user.company_id === null)) throw new Error('A user has no resolvable company');

  const adminColumn = ['is_admin', 'isAdmin'].find((column) => has('staff', column));
  const staffCompany = has('staff', 'company_id');
  const staffSql = `SELECT s.\`id\`, ${has('staff', 'store_id') ? 's.`store_id`' : 'NULL'} AS store_id, ${staffCompany ? 's.`company_id`' : 'st.`company_id`'} AS company_id, s.\`name\` AS name, ${has('staff', 'lunch_duration') ? 's.`lunch_duration`' : 'NULL'} AS lunch_duration, ${has('staff', 'pos') ? 's.`pos`' : 'NULL'} AS pos, ${has('staff', 'tasks') ? 's.`tasks`' : 'NULL'} AS tasks, ${adminColumn ? `s.\`${adminColumn}\`` : '0'} AS is_admin FROM \`staff\` s ${staffCompany || !has('staff', 'store_id') ? '' : 'LEFT JOIN `stores` st ON st.`id` = s.`store_id`'} ORDER BY s.\`id\``;
  let staffWithoutCompany = 0; let encryptedNames = 0;
  const staff = [];
  for (const row of await select(staffSql)) {
    if (row.company_id === null || row.company_id === undefined) { staffWithoutCompany += 1; continue; }
    const name = decryptField(row.name, appKey);
    if (name === row.name && looksEncrypted(name)) encryptedNames += 1;
    staff.push({ id: Number(row.id), store_id: intOrNull(row.store_id), company_id: Number(row.company_id), name_plain: name, lunch_duration: intOrNull(row.lunch_duration), pos: row.pos ?? null, tasks: row.tasks ?? null, is_admin: Number(row.is_admin) ? 1 : 0 });
  }
  if (encryptedNames > 0 && !allowEncryptedNames) throw new Error(`${encryptedNames} staff names look encrypted but could not be decrypted: check LEGACY_APP_KEY`);

  const roleRows = async (table, key) => (columns.has(table) ? (await select(`SELECT \`user_id\`, \`${key}\`, \`role\` FROM \`${table}\` ORDER BY \`user_id\`, \`${key}\`, \`role\``)).map((row) => ({ user_id: Number(row.user_id), [key]: Number(row[key]), role: row.role })) : []);
  const shiftColumns = ['id', 'staff_id', 'store_id', 'date', 'shift_hours', 'pos', 'break1', 'break1_duration', 'lunch', 'lunch_duration', 'break2', 'break2_duration', 'breaks', 'tasks', 'sign_off'];
  const shifts = (await select(pick('shifts', shiftColumns))).map((row) => {
    const result = {};
    for (const column of shiftColumns) {
      const value = row[column];
      result[column] = ['id', 'staff_id', 'store_id'].includes(column) ? intOrNull(value) : column === 'breaks' ? plainJson(value) : value ?? null;
    }
    return result;
  });
  const settings = (await optional('settings', ['id', 'scope', 'store_id', 'company_id', 'name', 'value'])).map((row) => ({ id: Number(row.id), scope: row.scope, store_id: intOrNull(row.store_id), company_id: intOrNull(row.company_id), name: row.name, value: row.value ?? null }));
  const breakTemplates = (await optional('break_templates', ['id', 'company_id', 'name', 'break1_offset', 'break1_duration', 'lunch_offset', 'lunch_duration', 'break2_offset', 'break2_duration'])).map((row) => ({ ...row, id: Number(row.id), company_id: intOrNull(row.company_id) }));
  const scheduleTemplates = (await optional('schedule_templates', ['id', 'name', 'payload'])).map((row) => ({ id: Number(row.id), name: row.name, payload: row.payload }));
  const chores = columns.has('chores') ? (await select('SELECT * FROM `chores` ORDER BY `id`')).map((row) => {
    const { created_at: _c, updated_at: _u, ...rest } = row;
    return { ...rest, id: Number(rest.id), store_id: Number(rest.store_id), assigned_to: intOrNull(rest.assigned_to), created_by: intOrNull(rest.created_by) };
  }) : [];

  const skipped_tables = {};
  for (const table of SKIPPED_TABLES) if (columns.has(table)) skipped_tables[table] = Number((await select(`SELECT COUNT(*) AS n FROM \`${table}\``))[0].n);
  if (staffWithoutCompany) skipped_tables.staff_without_company = staffWithoutCompany;

  const document = {
    format: SOURCE_FORMAT_V2, skipped_tables, companies, stores, users, staff,
    user_company_roles: await roleRows('user_company_roles', 'company_id'), user_store_roles: await roleRows('user_store_roles', 'store_id'),
    shifts, break_templates: breakTemplates, schedule_templates: scheduleTemplates, chores, settings,
  };
  return { document, stats: { usernameHashChecked: hashChecked, usernameHashMismatched: hashMismatched, staffNamesLookingEncrypted: encryptedNames, staffWithoutCompany } };
}

export function buildDescriptor({ sourceSha256, companies, namespace, targetGeneration, timezone, storeTimezones = {}, scheduleTemplateCompanyIds = [] }) {
  if (!/^[a-z][a-z0-9._:-]{2,127}$/.test(namespace ?? '')) throw new Error('--namespace must match [a-z][a-z0-9._:-]{2,127}');
  if (!UUID.test(targetGeneration ?? '')) throw new Error('--target-generation must be the UUID from legacy_import.target_generation');
  try { if (new Intl.DateTimeFormat('en-US', { timeZone: timezone }).resolvedOptions().timeZone !== timezone) throw new Error(); } catch { throw new Error('--timezone must be a canonical IANA identifier'); }
  return {
    schemaVersion: 1, namespace, targetGenerationId: targetGeneration.toLowerCase(), sourceSha256, adapterVersion: ADAPTER_VERSION_V2, rolePlanSha256: ROLE_PLAN_SHA256,
    companySlugs: Object.fromEntries(companies.map((company) => [String(company.id), `legacy-company-${company.id}`])), timezone,
    limits: { ...V2_LIMIT_MAXIMA },
    ...(Object.keys(storeTimezones).length ? { storeTimezones } : {}), ...(scheduleTemplateCompanyIds.length ? { scheduleTemplateCompanyIds } : {}),
  };
}

function writeExclusive(file, content) {
  const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600);
  try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}

// ---- CLI ---------------------------------------------------------------------------
const FLAGS = { '--host': 'host', '--port': 'port', '--user': 'user', '--database': 'database', '--socket': 'socketPath', '--out': 'out', '--descriptor-out': 'descriptorOut', '--namespace': 'namespace', '--target-generation': 'targetGeneration', '--timezone': 'timezone' };
export function parseArgs(argv, env = process.env) {
  const options = { host: env.LEGACY_MYSQL_HOST ?? '127.0.0.1', port: env.LEGACY_MYSQL_PORT ? Number(env.LEGACY_MYSQL_PORT) : 3306, user: env.LEGACY_MYSQL_USER, database: env.LEGACY_MYSQL_DATABASE, storeTimezones: {}, scheduleTemplateCompanyIds: [], allowHashMismatch: false, allowEncryptedNames: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--allow-username-hash-mismatch') { options.allowHashMismatch = true; continue; }
    if (flag === '--allow-undecryptable-names') { options.allowEncryptedNames = true; continue; }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) throw new Error(`Missing value for ${flag}`);
    index += 1;
    if (flag === '--store-timezone') { const match = /^(\d+)=(.+)$/.exec(value); if (!match) throw new Error('--store-timezone expects <legacyStoreId>=<IANA>'); options.storeTimezones[match[1]] = match[2]; continue; }
    if (flag === '--schedule-template-company') { if (!/^\d+$/.test(value)) throw new Error('--schedule-template-company expects a legacy company id'); options.scheduleTemplateCompanyIds.push(value); continue; }
    if (!FLAGS[flag]) throw new Error(`Unsupported option ${flag}`);
    options[FLAGS[flag]] = FLAGS[flag] === 'port' ? Number(value) : value;
  }
  if (!options.out || !options.user || !options.database) throw new Error('Usage: export-legacy-mysql.mjs --user U --database D --out export.json [--host H --port P --socket S] [--descriptor-out d.json --namespace N --target-generation UUID --timezone IANA [--store-timezone ID=IANA]... [--schedule-template-company ID]...]');
  if (options.descriptorOut && (!options.namespace || !options.targetGeneration || !options.timezone)) throw new Error('--descriptor-out requires --namespace, --target-generation and --timezone');
  return options;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const options = parseArgs(argv, env);
  const appKey = appKeyFrom(env.LEGACY_APP_KEY);
  const snapshot = await openSnapshot(options, env);
  let built;
  try { built = await buildExport(snapshot.select, appKey, options); } finally { await snapshot.close(); }
  const bytes = Buffer.from(`${JSON.stringify(built.document)}\n`, 'utf8');
  const sourceSha256 = sha256(bytes);
  writeExclusive(options.out, bytes);
  const result = { out: options.out, sourceSha256, bytes: bytes.length, counts: Object.fromEntries(Object.entries(built.document).filter(([, value]) => Array.isArray(value)).map(([key, value]) => [key, value.length])), skippedTables: built.document.skipped_tables, integrity: built.stats };
  if (options.descriptorOut) {
    const descriptor = buildDescriptor({ sourceSha256, companies: built.document.companies, namespace: options.namespace, targetGeneration: options.targetGeneration, timezone: options.timezone, storeTimezones: options.storeTimezones, scheduleTemplateCompanyIds: options.scheduleTemplateCompanyIds });
    const descriptorBytes = Buffer.from(`${JSON.stringify(descriptor, null, 2)}\n`, 'utf8');
    writeExclusive(options.descriptorOut, descriptorBytes);
    result.descriptor = { out: options.descriptorOut, descriptorSha256: sha256(descriptorBytes) };
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().then((result) => { console.log(JSON.stringify(result, null, 2)); }, (error) => {
    // Messages above never embed row data; driver errors are reduced to their code.
    console.error(error?.code && !error?.message?.startsWith('Refusing') ? `Legacy export failed (${error.code})` : `Legacy export failed: ${String(error?.message ?? error).replace(/\s+/g, ' ').slice(0, 300)}`);
    process.exitCode = 1;
  });
}
