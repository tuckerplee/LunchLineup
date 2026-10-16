#!/usr/bin/env node
/**
 * Idempotent internal-pilot tenant provisioning for the private staging stack
 * (VM107, https://dev.lunchlineup.com, DATA_TARGET_ENV=staging).
 *
 * Creates or reconciles, keyed on natural keys, in ONE database transaction:
 *   - the pilot Tenant (slug) on a paid plan in TRIAL with a bounded trialEndsAt;
 *   - the stored internal-beta entitlement (TenantSetting `internal_beta_entitlement`
 *     + immutable CreditTransaction + AuditLog), byte-for-byte the shape that
 *       apps/api InternalBetaEntitlementService.grant writes and that
 *       apps/api-v2 platform/feature-entitlement.ts verifies;
 *   - locations (tenant + name), the system RBAC roles, the owner/manager account
 *     (tenant + email; email one-time-passcode login, no password is ever set),
 *     and employees from a CSV (tenant + username) with random temporary PINs.
 *
 * Default is a DRY RUN: the full write path executes inside a transaction that is
 * always rolled back, so constraint and capacity failures surface without
 * persisting anything. `--apply` commits. Temporary PINs are written ONLY to the
 * `--pin-out` file (created exclusively, mode 0600) and never to stdout/stderr.
 *
 * Runs with only what the api-v2 image ships (node + @prisma/client): no build,
 * no TypeScript, no repository checkout. See docs/runbooks/pilot-tenant-provisioning.md.
 */
import { createHash, randomBytes, randomInt, scryptSync } from 'node:crypto';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';

// ---------------------------------------------------------------- constants
// Mirrors scripts/data-target-guard.mjs: staging is the only target that may run
// with NODE_ENV=production (VM107 does). Anything else, including unset, refuses.
export const ALLOWED_TARGETS = Object.freeze(['staging', 'development', 'test', 'disposable']);
const PRODUCTION_ENV_KEYS = ['APP_ENV', 'DEPLOY_ENV', 'NEXT_PUBLIC_APP_ENV'];
const PRODUCTION_MARKER = /(^|[\s._:/-])(prod|production)($|[\s._:/-])/i;

// Mirrors packages/config/internal-beta-origins.ts; a hygiene test asserts equality.
export const INTERNAL_BETA_ORIGINS = Object.freeze(['https://beta.lunchlineup.com', 'https://dev.lunchlineup.com']);
export const INTERNAL_BETA_COVERED_FEATURES = Object.freeze(['scheduling', 'lunch_breaks']);
// Mirrors apps/api/src/billing/plan-definitions.ts and metering.service.ts.
export const INTERNAL_BETA_ENTITLEMENT_KEY = 'internal_beta_entitlement';
export const INTERNAL_BETA_MAX_CREDITS = 1_000;
export const INTERNAL_BETA_MAX_DAYS = 90;
const INTERNAL_BETA_LEDGER_PREFIX = 'Internal beta scheduling entitlement: ';
const DAY_MS = 24 * 60 * 60 * 1000;

export const PAID_PLANS = Object.freeze(['STARTER', 'GROWTH', 'ENTERPRISE']);
// Fallback only when no PlanDefinition row exists (same table as feature-entitlement.ts).
const DEFAULT_PLAN_FEATURES = {
  STARTER: ['scheduling'],
  GROWTH: ['scheduling', 'lunch_breaks', 'time_cards'],
  ENTERPRISE: ['scheduling', 'lunch_breaks', 'time_cards'],
};

// Mirrors apps/api/src/auth/rbac.service.ts DEFAULT_ROLE_DEFINITIONS (admin, manager,
// staff); a hygiene test asserts equality. Permission rows themselves are seeded by
// the SQL migrations; this script only links roles to existing rows.
export const SYSTEM_ROLES = Object.freeze({
  admin: {
    name: 'Admin', description: 'Tenant administrator with staff and operations access.',
    legacyRole: 'ADMIN', isDefault: true,
    permissions: [
      'dashboard:access', 'auth:login_email', 'auth:login_pin', 'auth:login_password',
      'users:read', 'users:write', 'users:admin', 'roles:read', 'roles:write', 'roles:assign',
      'locations:read', 'locations:write', 'locations:delete',
      'shifts:read', 'shifts:write', 'shifts:delete',
      'schedules:read', 'schedules:write', 'schedules:publish',
      'lunch_breaks:read', 'lunch_breaks:write', 'lunch_breaks:delete',
      'time_cards:read', 'time_cards:write', 'time_cards:approve',
      'payroll:read', 'payroll:policy_write', 'payroll:lock', 'payroll:export', 'payroll:reconcile',
      'notifications:read', 'notifications:write', 'billing:read', 'billing:write',
      'settings:read', 'settings:write', 'tenant_account:lifecycle', 'account:data_export',
    ],
  },
  manager: {
    name: 'Manager', description: 'Store manager with scheduling and people access.',
    legacyRole: 'MANAGER', isDefault: false,
    permissions: [
      'dashboard:access', 'auth:login_email', 'auth:login_pin', 'auth:login_password',
      'users:read', 'users:write', 'roles:read', 'locations:read',
      'shifts:read', 'shifts:write', 'schedules:read', 'schedules:write', 'schedules:publish',
      'lunch_breaks:read', 'lunch_breaks:write',
      'time_cards:read', 'time_cards:write', 'time_cards:approve', 'payroll:read',
      'notifications:read', 'notifications:write',
    ],
  },
  staff: {
    name: 'Staff', description: 'Frontline staff member.',
    legacyRole: 'STAFF', isDefault: false,
    permissions: [
      'dashboard:access', 'auth:login_email', 'auth:login_pin', 'auth:login_password',
      'locations:read', 'shifts:read', 'schedules:read', 'lunch_breaks:read',
      'time_cards:read', 'time_cards:write', 'notifications:read', 'notifications:write',
    ],
  },
});
const ROLE_SLUG_BY_LEGACY = { ADMIN: 'admin', MANAGER: 'manager', STAFF: 'staff' };

// Validators copied from apps/api-v2/src/people/people.service.ts.
const USERNAME = /^[a-z0-9._-]{3,32}$/;
const EMAIL = /^[a-z0-9.!#$%*+/=?^_`{|}~-]+@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const MAX_SKILL_LENGTH = 64;
const SLUG = /^[a-z0-9](?:[a-z0-9-]{1,60}[a-z0-9])$/;
const MAX_EMPLOYEES = 1_000;

export class ProvisioningError extends Error {}
class DryRunRollback extends Error {}

// ------------------------------------------------------------- safety guards
export function assertSafeTarget(env = process.env) {
  const target = String(env.DATA_TARGET_ENV ?? '').trim().toLowerCase();
  if (!ALLOWED_TARGETS.includes(target)) {
    throw new ProvisioningError(
      `Refusing: DATA_TARGET_ENV must be one of ${ALLOWED_TARGETS.join(', ')} (got ${target ? `"${target}"` : 'unset'}). Never run against production.`,
    );
  }
  for (const key of PRODUCTION_ENV_KEYS) {
    if (String(env[key] ?? '').trim().toLowerCase() === 'production') {
      throw new ProvisioningError(`Refusing: ${key}=production.`);
    }
  }
  if (target !== 'staging' && String(env.NODE_ENV ?? '').trim().toLowerCase() === 'production') {
    throw new ProvisioningError('Refusing: NODE_ENV=production is only accepted together with DATA_TARGET_ENV=staging.');
  }
  const databaseUrl = String(env.DATABASE_URL ?? '').trim();
  if (!databaseUrl) throw new ProvisioningError('Refusing: DATABASE_URL is required.');
  let parsed;
  try { parsed = new URL(databaseUrl); } catch { throw new ProvisioningError('Refusing: DATABASE_URL is not a valid URL.'); }
  if (PRODUCTION_MARKER.test(`${parsed.username} ${parsed.hostname} ${parsed.pathname}`)) {
    throw new ProvisioningError('Refusing: DATABASE_URL looks like a production database (user/host/name contains "prod"/"production").');
  }
  if (!String(env.PLATFORM_ADMIN_DB_CONTEXT_SECRET ?? '').trim()) {
    throw new ProvisioningError('Refusing: PLATFORM_ADMIN_DB_CONTEXT_SECRET is required (tenant creation runs in the platform-admin database context).');
  }
  // The grant is only honoured by the runtime on an internal-beta origin with the flag on.
  if (String(env.INTERNAL_BETA_ENTITLEMENTS_ENABLED ?? '').trim().toLowerCase() !== 'true') {
    throw new ProvisioningError('Refusing: INTERNAL_BETA_ENTITLEMENTS_ENABLED must be "true"; otherwise the grant would be inert.');
  }
  const origin = String(env.APP_ORIGIN ?? '').trim();
  if (!isInternalBetaOrigin(origin)) {
    throw new ProvisioningError(`Refusing: APP_ORIGIN must be exactly one of ${INTERNAL_BETA_ORIGINS.join(', ')}.`);
  }
  return { target, origin };
}

export function isInternalBetaOrigin(value) {
  try {
    const url = new URL(value ?? '');
    return INTERNAL_BETA_ORIGINS.includes(url.origin) && url.pathname === '/' && !url.search && !url.hash
      && !url.username && !url.password;
  } catch { return false; }
}

// ------------------------------------------------------------------ parsing
const OPTION_SPEC = {
  'org-name': { type: 'string' }, 'org-slug': { type: 'string' }, plan: { type: 'string' },
  'trial-days': { type: 'string' }, 'grant-credits': { type: 'string' }, 'grant-days': { type: 'string' },
  'grant-label': { type: 'string' }, 'grant-reason': { type: 'string' },
  location: { type: 'string', multiple: true },
  'manager-email': { type: 'string' }, 'manager-name': { type: 'string' }, 'manager-role': { type: 'string' },
  'send-invite': { type: 'boolean' },
  'employees-csv': { type: 'string' }, 'pin-out': { type: 'string' },
  operator: { type: 'string' }, apply: { type: 'boolean' }, 'dry-run': { type: 'boolean' }, help: { type: 'boolean' },
};

export const USAGE = `Usage: provision-pilot-tenant.mjs --org-name NAME --org-slug SLUG --manager-email EMAIL [options]

Default is a dry run (full write path, always rolled back). Add --apply to commit.

Required
  --org-name NAME           Display name of the pilot organization
  --org-slug SLUG           Natural key (lowercase letters, digits, hyphens; 3-62 chars)
  --manager-email EMAIL     Owner/manager account (email one-time-passcode login)
Options
  --location "NAME|IANA_TZ[|ADDRESS]"   Repeatable; natural key is the name (case-insensitive)
  --manager-name NAME       Default "Pilot Owner"
  --manager-role ADMIN|MANAGER          Default ADMIN
  --send-invite             Enqueue the standard staff-invitation email for a NEW owner
                            (needs STAFF_INVITATION_OUTBOX_* and the api-v2 image)
  --employees-csv PATH      Columns: name (required), email, phone, username, position|role, access_role
  --pin-out PATH            New file (mode 0600, must not exist) receiving temporary PINs
  --plan STARTER|GROWTH|ENTERPRISE      Default GROWTH (must include scheduling and lunch_breaks)
  --trial-days N            Default 30 (1-${INTERNAL_BETA_MAX_DAYS}); only used when the tenant is created
  --grant-credits N         Default 100 (1-${INTERNAL_BETA_MAX_CREDITS}); usage-credit wallet seed
  --grant-days N            Default = trial length; the grant can never outlive the trial
  --grant-label LABEL       Default v1; use v2 to renew an expired grant
  --grant-reason TEXT       Default "Internal pilot"
  --operator NAME           Recorded in the audit trail
  --apply                   Commit (otherwise rolled back)
  --dry-run                 Explicit default
`;

export function parseCli(argv) {
  const { values } = parseArgs({ args: argv, options: OPTION_SPEC, allowPositionals: false, strict: true });
  if (values.help) return { help: true };
  if (values.apply && values['dry-run']) throw new ProvisioningError('Choose either --apply or --dry-run, not both.');
  const required = (key) => {
    const value = String(values[key] ?? '').trim();
    if (!value) throw new ProvisioningError(`--${key} is required.`);
    return value;
  };
  const integer = (key, fallback, min, max) => {
    if (values[key] === undefined) return fallback;
    if (!/^\d+$/.test(values[key])) throw new ProvisioningError(`--${key} must be a whole number.`);
    const n = Number(values[key]);
    if (n < min || n > max) throw new ProvisioningError(`--${key} must be between ${min} and ${max}.`);
    return n;
  };
  const slug = required('org-slug');
  if (!SLUG.test(slug)) throw new ProvisioningError('--org-slug must be 3-62 lowercase letters, digits or hyphens, not starting/ending with a hyphen.');
  const orgName = required('org-name');
  if (orgName.length > 120 || /[\u0000-\u001f\u007f]/.test(orgName)) throw new ProvisioningError('--org-name must be 1-120 printable characters.');
  const managerEmail = required('manager-email').toLowerCase();
  if (!EMAIL.test(managerEmail) || managerEmail.length > 254) throw new ProvisioningError('--manager-email is not a valid email address.');
  const plan = String(values.plan ?? 'GROWTH').trim().toUpperCase();
  if (!PAID_PLANS.includes(plan)) throw new ProvisioningError(`--plan must be one of ${PAID_PLANS.join(', ')} (a paid plan).`);
  const managerRole = String(values['manager-role'] ?? 'ADMIN').trim().toUpperCase();
  if (!['ADMIN', 'MANAGER'].includes(managerRole)) throw new ProvisioningError('--manager-role must be ADMIN or MANAGER.');
  const trialDays = integer('trial-days', 30, 1, INTERNAL_BETA_MAX_DAYS);
  const grantDays = integer('grant-days', trialDays, 1, INTERNAL_BETA_MAX_DAYS);
  if (grantDays > trialDays) throw new ProvisioningError('--grant-days cannot exceed --trial-days (the grant may not outlive the trial).');
  const grantLabel = String(values['grant-label'] ?? 'v1').trim();
  if (!/^[A-Za-z0-9._-]{1,32}$/.test(grantLabel)) throw new ProvisioningError('--grant-label must be 1-32 of A-Z a-z 0-9 . _ -');
  const grantReason = String(values['grant-reason'] ?? 'Internal pilot').trim();
  if (!grantReason || grantReason.length > 200 || /[\u0000-\u001f\u007f]/.test(grantReason)) {
    throw new ProvisioningError('--grant-reason must be 1-200 printable characters.');
  }
  const locations = (values.location ?? []).map(parseLocation);
  const seen = new Set();
  for (const location of locations) {
    const key = location.name.toLowerCase();
    if (seen.has(key)) throw new ProvisioningError(`Duplicate --location "${location.name}".`);
    seen.add(key);
  }
  const apply = Boolean(values.apply);
  if (apply && values['employees-csv'] && !values['pin-out']) {
    throw new ProvisioningError('--pin-out is required with --apply and --employees-csv (temporary PINs are never printed).');
  }
  return {
    apply, orgName, slug, managerEmail, plan, managerRole, trialDays, grantDays, grantLabel, grantReason,
    managerName: String(values['manager-name'] ?? 'Pilot Owner').trim() || 'Pilot Owner',
    credits: integer('grant-credits', 100, 1, INTERNAL_BETA_MAX_CREDITS),
    locations, sendInvite: Boolean(values['send-invite']),
    employeesCsv: values['employees-csv'] ?? null, pinOut: values['pin-out'] ?? null,
    operator: String(values.operator ?? process.env.USER ?? 'operator').trim().slice(0, 64) || 'operator',
  };
}

export function parseLocation(spec) {
  const [name, timezone, ...rest] = String(spec).split('|').map((part) => part.trim());
  if (!name || !timezone) throw new ProvisioningError(`--location must be "NAME|IANA_TZ[|ADDRESS]" (got "${spec}").`);
  if (name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new ProvisioningError('Location name must be 1-120 printable characters.');
  try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }); } catch { throw new ProvisioningError(`Unknown IANA timezone "${timezone}".`); }
  const address = rest.join('|').trim();
  return { name, timezone, address: address || null };
}

/** Minimal RFC 4180 parser: quoted fields, doubled quotes, CRLF/LF, BOM. */
export function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;
  const src = text.replace(/^﻿/, '');
  for (let i = 0; i < src.length; i += 1) {
    const ch = src[i];
    if (quoted) {
      if (ch === '"') {
        if (src[i + 1] === '"') { field += '"'; i += 1; } else quoted = false;
      } else field += ch;
    } else if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && src[i + 1] === '\n') i += 1;
      row.push(field); field = '';
      if (row.some((cell) => cell.trim() !== '')) rows.push(row);
      row = [];
    } else field += ch;
  }
  if (quoted) throw new ProvisioningError('CSV has an unterminated quoted field.');
  row.push(field);
  if (row.some((cell) => cell.trim() !== '')) rows.push(row);
  return rows;
}

export function deriveUsername(name) {
  const base = name.normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0, 32).replace(/\.+$/g, '');
  return base;
}

export function parseEmployees(text) {
  const rows = parseCsv(text);
  if (rows.length < 2) throw new ProvisioningError('Employee CSV needs a header row and at least one employee.');
  const header = rows[0].map((cell) => cell.trim().toLowerCase());
  const known = new Set(['name', 'email', 'phone', 'username', 'position', 'role', 'access_role']);
  for (const column of header) {
    if (!known.has(column)) throw new ProvisioningError(`Unknown CSV column "${column}". Allowed: ${[...known].join(', ')}.`);
  }
  if (new Set(header).size !== header.length) throw new ProvisioningError('Duplicate CSV column.');
  if (!header.includes('name')) throw new ProvisioningError('Employee CSV requires a "name" column.');
  if (rows.length - 1 > MAX_EMPLOYEES) throw new ProvisioningError(`At most ${MAX_EMPLOYEES} employees per run.`);
  const employees = [];
  const usernames = new Map();
  const emails = new Map();
  rows.slice(1).forEach((cells, index) => {
    const line = index + 2;
    if (cells.length > header.length) throw new ProvisioningError(`CSV line ${line}: more fields than columns.`);
    const get = (column) => String(cells[header.indexOf(column)] ?? '').trim();
    const name = get('name').replace(/\s+/g, ' ');
    if (!name || name.length > 120 || /[\u0000-\u001f\u007f]/.test(name)) throw new ProvisioningError(`CSV line ${line}: name must be 1-120 printable characters.`);
    const email = get('email').toLowerCase();
    if (email && (!EMAIL.test(email) || email.length > 254)) throw new ProvisioningError(`CSV line ${line}: invalid email.`);
    const phone = get('phone');
    if (phone && (phone.length > 32 || !/^[0-9+().\-\s]+$/.test(phone))) throw new ProvisioningError(`CSV line ${line}: invalid phone.`);
    const username = (get('username').toLowerCase()) || deriveUsername(name);
    if (!USERNAME.test(username)) {
      throw new ProvisioningError(`CSV line ${line}: username "${username}" must be 3-32 of a-z 0-9 . _ - (set a "username" column value).`);
    }
    const position = (get('position') || get('role')).trim().replace(/\s+/g, ' ').toLowerCase();
    if (position.length > MAX_SKILL_LENGTH) throw new ProvisioningError(`CSV line ${line}: position must be at most ${MAX_SKILL_LENGTH} characters.`);
    const access = (get('access_role') || 'STAFF').toUpperCase();
    if (!['STAFF', 'MANAGER'].includes(access)) throw new ProvisioningError(`CSV line ${line}: access_role must be STAFF or MANAGER.`);
    if (usernames.has(username)) {
      throw new ProvisioningError(`CSV line ${line}: username "${username}" duplicates line ${usernames.get(username)}; provide a distinct "username" value.`);
    }
    usernames.set(username, line);
    if (email) {
      if (emails.has(email)) throw new ProvisioningError(`CSV line ${line}: email duplicates line ${emails.get(email)}.`);
      emails.set(email, line);
    }
    employees.push({ name, email: email || null, phone: phone || null, username, position: position || null, access });
  });
  return employees;
}

// ------------------------------------------------------------------ crypto
/** Same scheme as apps/api-v2 people.service.ts hashPin: `${salt}:${scrypt(pin, salt, 64)}` (hex). */
export function hashPin(pin) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(pin, salt, 64).toString('hex')}`;
}
export function temporaryPin() {
  return randomInt(100_000, 1_000_000).toString();
}
const sha256 = (value) => createHash('sha256').update(value, 'utf8').digest('hex');

export function creditGrantTransactionId(tenantId, idempotencyKey) {
  // administrativeCreditGrantTransactionId(tenantId, `internal-beta-entitlement:${key}`)
  return `admin-credit-grant-${sha256(`${tenantId}:internal-beta-entitlement:${idempotencyKey}`)}`;
}

function neutralizeCsvCell(value) {
  const text = String(value ?? '');
  return /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
}
function csvCell(value) {
  const text = neutralizeCsvCell(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

/** Creates the PIN file exclusively with mode 0600, fsyncs, and returns its path. */
export function writePinFile(file, slug, rows) {
  const lines = ['tenant_slug,username,name,temporary_pin,pin_reset_required'];
  for (const row of rows) lines.push([slug, row.username, row.name, row.pin, 'true'].map(csvCell).join(','));
  let fd;
  try {
    fd = fs.openSync(file, 'wx', 0o600);
  } catch (error) {
    throw new ProvisioningError(`Cannot create PIN file "${file}" (it must not already exist and its directory must be writable): ${error.code ?? error.message}`);
  }
  try {
    fs.fchmodSync?.(fd, 0o600);
    fs.writeSync(fd, `${lines.join('\n')}\n`);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  return file;
}

// -------------------------------------------------------------- provisioning
function planFeatures(plan, code) {
  const metadata = plan?.metadata;
  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) return DEFAULT_PLAN_FEATURES[code] ?? [];
  return Array.isArray(metadata.features) ? metadata.features : [];
}

function printable(value, max) {
  return typeof value === 'string' && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);
}

async function ensureRoles(tx, tenantId, slugs, permissionIdByKey) {
  const ids = {};
  for (const slug of slugs) {
    const definition = SYSTEM_ROLES[slug];
    let role = await tx.role.findFirst({ where: { tenantId, slug } });
    if (!role) {
      role = await tx.role.create({
        data: {
          tenantId, slug, name: definition.name, description: definition.description,
          isSystem: true, isDefault: definition.isDefault, legacyRole: definition.legacyRole,
        },
      });
    } else if (role.deletedAt) {
      throw new ProvisioningError(`System role "${slug}" is soft-deleted in this tenant; resolve manually.`);
    }
    // Additive only: never strip permissions an operator may have adjusted.
    await tx.rolePermission.createMany({
      data: definition.permissions.map((key) => ({ roleId: role.id, permissionId: permissionIdByKey.get(key) })),
      skipDuplicates: true,
    });
    ids[slug] = role.id;
  }
  return ids;
}

/**
 * Core reconcile. `tx` is a Prisma transaction client already in platform-admin
 * context. Returns a secret-free report plus the PINs generated for NEW employees.
 */
export async function reconcile(tx, options, employees, { now, outbox }) {
  const report = { tenant: null, grant: null, locations: [], manager: null, employees: [], changed: false };
  const newPins = [];

  const [{ name: databaseName } = {}] = await tx.$queryRaw`SELECT current_database() AS name`;
  if (PRODUCTION_MARKER.test(String(databaseName ?? ''))) {
    throw new ProvisioningError(`Refusing: connected database "${databaseName}" looks like production.`);
  }

  // ---- plan
  const plan = await tx.planDefinition.findUnique({ where: { code: options.plan } });
  if (plan && plan.active === false) throw new ProvisioningError(`Plan ${options.plan} is inactive.`);
  const features = planFeatures(plan, options.plan);
  for (const feature of INTERNAL_BETA_COVERED_FEATURES) {
    if (!features.includes(feature)) {
      throw new ProvisioningError(`Plan ${options.plan} does not include "${feature}"; the entitlement would be unusable. Use --plan GROWTH.`);
    }
  }

  // ---- permissions must already exist (seeded by migrations)
  const roleSlugs = ['staff', ROLE_SLUG_BY_LEGACY[options.managerRole], ...(employees.some((e) => e.access === 'MANAGER') ? ['manager'] : [])];
  const uniqueSlugs = [...new Set(roleSlugs)];
  const needKeys = [...new Set(uniqueSlugs.flatMap((slug) => SYSTEM_ROLES[slug].permissions))];
  const permissions = await tx.permission.findMany({ where: { key: { in: needKeys } }, select: { id: true, key: true } });
  const permissionIdByKey = new Map(permissions.map((p) => [p.key, p.id]));
  const missingKeys = needKeys.filter((key) => !permissionIdByKey.has(key));
  if (missingKeys.length) throw new ProvisioningError(`Permission catalog is incomplete (missing: ${missingKeys.join(', ')}). Run the database migrations first.`);

  // ---- tenant
  let tenant = await tx.tenant.findUnique({ where: { slug: options.slug } });
  if (tenant) {
    if (tenant.deletedAt) throw new ProvisioningError(`Tenant "${options.slug}" is deleted; choose another slug.`);
    if (tenant.planTier !== options.plan) throw new ProvisioningError(`Tenant "${options.slug}" exists on plan ${tenant.planTier}, not ${options.plan}; refusing to change plans.`);
    if (tenant.status !== 'TRIAL') throw new ProvisioningError(`Tenant "${options.slug}" exists with status ${tenant.status}, expected TRIAL.`);
    if (!(tenant.trialEndsAt instanceof Date) || tenant.trialEndsAt <= now) throw new ProvisioningError(`Tenant "${options.slug}" trial has ended.`);
    report.tenant = { id: tenant.id, slug: tenant.slug, action: 'exists', status: tenant.status, planTier: tenant.planTier, trialEndsAt: tenant.trialEndsAt.toISOString() };
    if (tenant.name !== options.orgName) report.tenant.note = `name differs ("${tenant.name}"); kept`;
  } else {
    tenant = await tx.tenant.create({
      data: {
        name: options.orgName, slug: options.slug, planTier: options.plan, status: 'TRIAL',
        trialEndsAt: new Date(now.getTime() + options.trialDays * DAY_MS), usageCredits: 0,
      },
    });
    await tx.auditLog.create({
      data: {
        tenantId: tenant.id, userId: null, actorUserId: null, actorTenantId: null,
        action: 'TENANT_CREATED', resource: 'Tenant', resourceId: tenant.id,
        newValue: { source: 'pilot-provisioning-script', operator: options.operator, planTier: options.plan, status: 'TRIAL' },
      },
    });
    report.tenant = { id: tenant.id, slug: tenant.slug, action: 'create', status: 'TRIAL', planTier: options.plan, trialEndsAt: tenant.trialEndsAt.toISOString() };
    report.changed = true;
  }
  const tenantId = tenant.id;

  // Same lock order as the grant service and feature-entitlement debit path.
  await tx.$executeRaw`LOCK TABLE "Tenant", "CreditTransaction" IN ROW EXCLUSIVE MODE`;
  await tx.$queryRaw`SELECT "id" FROM "Tenant" WHERE "id" = ${tenantId} FOR UPDATE`;

  // ---- roles
  const roleIds = await ensureRoles(tx, tenantId, uniqueSlugs, permissionIdByKey);

  // ---- locations (capacity: effective plan limit)
  const activeLocations = await tx.location.count({ where: { tenantId, deletedAt: null } });
  let plannedLocations = activeLocations;
  for (const spec of options.locations) {
    const keyHash = sha256(`pilot-provision:location:${options.slug}:${spec.name.toLowerCase()}`);
    const existing = await tx.location.findFirst({
      where: { tenantId, deletedAt: null, OR: [{ creationRequestKeyHash: keyHash }, { name: { equals: spec.name, mode: 'insensitive' } }] },
      select: { publicId: true, name: true, timezone: true },
    });
    if (existing) {
      const entry = { name: existing.name, action: 'exists' };
      if (existing.timezone !== spec.timezone) entry.note = `timezone differs (${existing.timezone}); kept`;
      report.locations.push(entry);
      continue;
    }
    if (plan?.locationLimit != null && plannedLocations >= plan.locationLimit) {
      throw new ProvisioningError(`Location limit reached for ${options.plan} (${plan.locationLimit}).`);
    }
    await tx.location.create({
      data: {
        tenantId, name: spec.name, address: spec.address, timezone: spec.timezone,
        creationRequestKeyHash: keyHash,
        creationRequestHash: sha256(JSON.stringify({ name: spec.name, address: spec.address, timezone: spec.timezone })),
      },
    });
    plannedLocations += 1;
    report.locations.push({ name: spec.name, action: 'create' });
    report.changed = true;
  }

  // ---- manager / owner
  const capacity = async (adding) => {
    if (plan?.userLimit == null) return;
    const count = await tx.user.count({ where: { tenantId, deletedAt: null, suspendedAt: null } });
    if (count + adding > plan.userLimit) throw new ProvisioningError(`User limit reached for ${options.plan} (${plan.userLimit}).`);
  };
  let manager = await tx.user.findFirst({ where: { tenantId, email: options.managerEmail } });
  if (manager) {
    if (manager.deletedAt || manager.suspendedAt) throw new ProvisioningError('Owner/manager account exists but is deleted or suspended; resolve manually.');
    report.manager = { action: 'exists', role: manager.role };
    if (manager.role !== options.managerRole) report.manager.note = `existing role ${manager.role} differs from requested ${options.managerRole}; kept`;
  } else {
    await capacity(1);
    manager = await tx.user.create({
      data: {
        tenantId, email: options.managerEmail, name: options.managerName, role: options.managerRole,
        mfaEnabled: false, mfaBackupCodes: [], passwordHash: null, pinHash: null,
      },
    });
    report.manager = { action: 'create', role: options.managerRole };
    report.changed = true;
  }
  const managerRoleId = roleIds[ROLE_SLUG_BY_LEGACY[manager.role]];
  if (managerRoleId) {
    await tx.roleAssignment.createMany({ data: [{ tenantId, userId: manager.id, roleId: managerRoleId }], skipDuplicates: true });
  }
  if (options.sendInvite) {
    const existingInvite = await tx.staffInvitationOutbox.findUnique({
      where: { tenantId_userId_purpose: { tenantId, userId: manager.id, purpose: 'STAFF_INVITATION' } },
      select: { status: true },
    });
    if (existingInvite) report.manager.invitation = `already queued (${existingInvite.status}); not re-sent`;
    else if (!outbox) throw new ProvisioningError('--send-invite requires the api-v2 invitation outbox (run inside the api-v2 image).');
    else {
      const delivery = await outbox.enqueue(tx, { tenantId, userId: manager.id, recipient: options.managerEmail });
      report.manager.invitation = `enqueued (${delivery.status})`;
      report.changed = true;
    }
  }

  // ---- employees
  for (const employee of employees) {
    const existing = await tx.user.findFirst({ where: { tenantId, username: employee.username } });
    const roleSlug = ROLE_SLUG_BY_LEGACY[employee.access];
    if (existing) {
      if (existing.deletedAt || existing.suspendedAt) throw new ProvisioningError(`Employee "${employee.username}" exists but is deleted or suspended; resolve manually.`);
      const entry = { username: employee.username, action: 'exists', pin: 'unchanged' };
      const drift = [];
      if (existing.name !== employee.name) drift.push('name');
      if (employee.email && existing.email !== employee.email) drift.push('email');
      if (employee.phone && existing.phone !== employee.phone) drift.push('phone');
      if (drift.length) entry.note = `${drift.join('/')} differs from CSV; kept`;
      report.employees.push(entry);
      const existingRoleId = roleIds[ROLE_SLUG_BY_LEGACY[existing.role]];
      if (existingRoleId) await tx.roleAssignment.createMany({ data: [{ tenantId, userId: existing.id, roleId: existingRoleId }], skipDuplicates: true });
      continue;
    }
    if (employee.email) {
      const emailOwner = await tx.user.findFirst({ where: { tenantId, email: employee.email }, select: { id: true, username: true } });
      if (emailOwner) throw new ProvisioningError(`Employee "${employee.username}": email already belongs to another account in this tenant.`);
    }
    await capacity(1);
    const pin = temporaryPin();
    const user = await tx.user.create({
      data: {
        tenantId, name: employee.name, username: employee.username, email: employee.email, phone: employee.phone,
        role: employee.access, mfaEnabled: false, mfaBackupCodes: [], passwordHash: null,
        pinHash: hashPin(pin), pinSetAt: now, pinResetRequired: true, pinLoginAttempts: 0, pinLockedUntil: null,
      },
    });
    await tx.roleAssignment.createMany({ data: [{ tenantId, userId: user.id, roleId: roleIds[roleSlug] }], skipDuplicates: true });
    if (employee.position) {
      await tx.staffSkill.createMany({ data: [{ tenantId, userId: user.id, skill: employee.position }], skipDuplicates: true });
    }
    newPins.push({ username: employee.username, name: employee.name, pin });
    report.employees.push({ username: employee.username, action: 'create', pin: 'generated (see --pin-out)' });
    report.changed = true;
  }

  // ---- internal-beta grant (shape of InternalBetaEntitlementService.grant)
  report.grant = await reconcileGrant(tx, tenant, options, now);
  if (report.grant.action === 'create') report.changed = true;

  if (report.changed) {
    await tx.auditLog.create({
      data: {
        tenantId, userId: null, actorUserId: null, actorTenantId: null,
        action: 'PILOT_PROVISIONING_APPLIED', resource: 'Tenant', resourceId: tenantId,
        newValue: {
          source: 'pilot-provisioning-script', operator: options.operator,
          locationsCreated: report.locations.filter((l) => l.action === 'create').length,
          employeesCreated: newPins.length, grantAction: report.grant.action,
        },
      },
    });
  }
  return { report, newPins };
}

async function reconcileGrant(tx, tenant, options, now) {
  const tenantId = tenant.id;
  const idempotencyKey = `pilot-provision-${options.slug}-${options.grantLabel}`;
  const grantId = creditGrantTransactionId(tenantId, idempotencyKey);
  const auditId = `${grantId}-internal-beta-audit`;
  const current = await tx.tenant.findUniqueOrThrow({ where: { id: tenantId }, select: { usageCredits: true, creditDebt: true, trialEndsAt: true } });
  const trialEndsAt = current.trialEndsAt;
  const stored = await tx.tenantSetting.findUnique({ where: { tenantId_key: { tenantId, key: INTERNAL_BETA_ENTITLEMENT_KEY } }, select: { value: true } });
  const value = stored?.value;
  const priorGrantId = value && typeof value === 'object' && !Array.isArray(value) ? value.grantId : null;
  const priorExpires = value && typeof value === 'object' && !Array.isArray(value) && typeof value.expiresAt === 'string' ? new Date(value.expiresAt) : null;
  const priorActive = value?.status === 'ACTIVE' && priorExpires && priorExpires > now;

  if (priorGrantId === grantId) {
    if (!priorActive) {
      throw new ProvisioningError(`The "${options.grantLabel}" internal-beta grant has expired; rerun with a new --grant-label (for example v2) to renew it.`);
    }
    return { action: 'exists', grantId, expiresAt: value.expiresAt, creditsGranted: value.creditsGranted };
  }
  if (priorActive) {
    return { action: 'exists', grantId: priorGrantId, expiresAt: value.expiresAt, creditsGranted: value.creditsGranted, note: `active grant from another label is in force; "${options.grantLabel}" not applied` };
  }
  if (current.creditDebt !== 0) throw new ProvisioningError('Credit debt is outstanding; the internal-beta grant cannot be issued.');
  if (!(trialEndsAt instanceof Date) || trialEndsAt <= now) throw new ProvisioningError('Tenant trial has ended; cannot grant.');
  const requestedEnd = new Date(now.getTime() + options.grantDays * DAY_MS);
  const expiresAt = requestedEnd > trialEndsAt ? trialEndsAt : requestedEnd;
  if (expiresAt <= now || expiresAt.getTime() > now.getTime() + INTERNAL_BETA_MAX_DAYS * DAY_MS) {
    throw new ProvisioningError('Computed grant expiry is outside the allowed window.');
  }
  const ledgerReason = `${INTERNAL_BETA_LEDGER_PREFIX}${options.grantReason}`;
  if (!printable(ledgerReason, 500) || !printable(options.grantReason, 240)) throw new ProvisioningError('Grant reason is not printable or too long.');
  const approvedByUserId = `pilot-provisioning-script:${options.operator}`;

  if (await tx.creditTransaction.findUnique({ where: { id: grantId }, select: { id: true } })) {
    throw new ProvisioningError('A credit transaction for this grant already exists without its setting; refusing to guess. Use a new --grant-label.');
  }
  const updated = await tx.tenant.update({
    where: { id: tenantId }, data: { usageCredits: { increment: options.credits } }, select: { usageCredits: true, creditDebt: true },
  });
  await tx.creditTransaction.create({
    data: {
      id: grantId, tenantId, amount: options.credits, debtAmount: 0, reason: ledgerReason,
      balanceAfter: updated.usageCredits, debtAfter: updated.creditDebt,
    },
  });
  const approvedAt = now.toISOString();
  const entitlement = {
    version: 1, source: 'internal_beta', status: 'ACTIVE',
    features: ['scheduling'], // stored shape is fixed; lunch_breaks is covered by isInternalBetaCoveredFeature
    grantId, auditId, creditTransactionId: grantId, creditsGranted: options.credits, ledgerReason,
    reason: options.grantReason, approvedAt, approvedByUserId, expiresAt: expiresAt.toISOString(),
  };
  const response = { tenantId, grantId, creditTransactionId: grantId, creditsGranted: options.credits, newBalance: updated.usageCredits, approvedAt, expiresAt: entitlement.expiresAt };
  await tx.tenantSetting.upsert({
    where: { tenantId_key: { tenantId, key: INTERNAL_BETA_ENTITLEMENT_KEY } },
    create: { tenantId, key: INTERNAL_BETA_ENTITLEMENT_KEY, value: entitlement },
    update: { value: entitlement },
  });
  await tx.auditLog.create({
    data: {
      id: auditId, tenantId, userId: null, actorUserId: null, actorTenantId: null,
      action: 'INTERNAL_BETA_ENTITLEMENT_GRANTED', resource: 'TenantSetting', resourceId: grantId,
      oldValue: stored?.value ?? undefined,
      newValue: {
        requestHash: sha256(JSON.stringify([tenantId, options.credits, entitlement.expiresAt, options.grantReason])),
        entitlement, response,
      },
    },
  });
  return { action: 'create', grantId, expiresAt: entitlement.expiresAt, creditsGranted: options.credits, newBalance: updated.usageCredits, coveredFeatures: [...INTERNAL_BETA_COVERED_FEATURES] };
}

/** Runs reconcile in one platform-admin transaction; rolls back unless apply. */
export async function provision({ prisma, env = process.env, options, employees = [], now = new Date(), outbox = null, fsApi = fs }) {
  let writtenPinFile = null;
  try {
    const result = await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT set_current_platform_admin(true, ${String(env.PLATFORM_ADMIN_DB_CONTEXT_SECRET).trim()})`;
      const outcome = await reconcile(tx, options, employees, { now, outbox });
      if (options.apply && outcome.newPins.length) {
        if (!options.pinOut) throw new ProvisioningError('--pin-out is required to receive temporary PINs.');
        // Written before commit: a failed write aborts the transaction; a failed commit removes the file.
        writtenPinFile = writePinFile(options.pinOut, options.slug, outcome.newPins);
      }
      if (!options.apply) throw Object.assign(new DryRunRollback('dry-run'), { outcome });
      return outcome;
    }, { maxWait: 10_000, timeout: 120_000 });
    return { applied: true, report: result.report, pinFile: writtenPinFile, pinCount: result.newPins.length };
  } catch (error) {
    if (error instanceof DryRunRollback) {
      return { applied: false, report: error.outcome.report, pinFile: null, pinCount: error.outcome.newPins.length };
    }
    if (writtenPinFile) { try { fsApi.unlinkSync(writtenPinFile); } catch { /* best effort */ } }
    throw error;
  }
}

// ---------------------------------------------------------------------- CLI
function resolveAppRoot(env) {
  const candidates = [env.PILOT_APP_ROOT, process.cwd(), '/app'].filter(Boolean).map((p) => path.resolve(p));
  const hit = candidates.find((dir) => fs.existsSync(path.join(dir, 'node_modules', '@prisma', 'client')));
  if (!hit) throw new ProvisioningError(`@prisma/client not found under ${candidates.join(' or ')}; set PILOT_APP_ROOT to the api-v2 app root (/app in the image).`);
  return hit;
}

function loadOutbox(appRoot, env) {
  const file = path.join(appRoot, 'dist', 'people', 'invitation-outbox.js');
  if (!fs.existsSync(file)) return null;
  const { InvitationOutbox } = createRequire(pathToFileURL(path.join(appRoot, 'package.json')))(file);
  return new InvitationOutbox({
    staffInvitationOutboxEnabled: String(env.STAFF_INVITATION_OUTBOX_ENABLED ?? '').trim().toLowerCase() === 'true',
    staffInvitationOutboxEncryptionKey: String(env.STAFF_INVITATION_OUTBOX_ENCRYPTION_KEY ?? ''),
    staffInvitationMaxAttempts: Math.min(8, Math.max(1, Number(env.STAFF_INVITATION_MAX_ATTEMPTS) || 8)),
  });
}

export async function main(argv = process.argv.slice(2), env = process.env, io = { out: (s) => process.stdout.write(s), err: (s) => process.stderr.write(s) }) {
  let prisma;
  try {
    const options = parseCli(argv);
    if (options.help) { io.out(USAGE); return 0; }
    assertSafeTarget(env);
    const employees = options.employeesCsv ? parseEmployees(fs.readFileSync(options.employeesCsv, 'utf8')) : [];
    const appRoot = resolveAppRoot(env);
    const { PrismaClient } = createRequire(pathToFileURL(path.join(appRoot, 'package.json')))('@prisma/client');
    prisma = new PrismaClient();
    const outbox = options.sendInvite ? loadOutbox(appRoot, env) : null;
    const result = await provision({ prisma, env, options, employees, outbox });
    io.out(`${JSON.stringify({
      mode: result.applied ? 'APPLIED' : 'DRY_RUN (full path executed, then rolled back; nothing persisted)',
      target: String(env.DATA_TARGET_ENV).trim().toLowerCase(),
      ...result.report,
      pinFile: result.pinFile, temporaryPinsGenerated: result.pinCount,
    }, null, 2)}\n`);
    if (!result.applied) io.out('Re-run with --apply to commit.\n');
    return 0;
  } catch (error) {
    // Database client errors can echo query arguments; print only their code/meta, never the message.
    const safe = error instanceof ProvisioningError ? error.message
      : [error?.name ?? 'Error', error?.code, error?.meta ? JSON.stringify(error.meta).slice(0, 200) : null,
        error?.code === 'ENOENT' ? String(error.message).slice(0, 200) : null].filter(Boolean).join(' ');
    io.err(`ERROR: ${safe}\n`);
    return error instanceof ProvisioningError ? 2 : 1;
  } finally {
    if (prisma) await prisma.$disconnect().catch(() => undefined);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exitCode = await main();
}
