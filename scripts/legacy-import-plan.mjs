import crypto from 'node:crypto';

const Category = Object.fromEntries(['AUTH','ADMIN','USERS','LOCATIONS','SHIFTS','SCHEDULES','LUNCH_BREAKS','NOTIFICATIONS','BILLING','SETTINGS'].map((key) => [key,key]));
const LegacyRole = Object.fromEntries(['SUPER_ADMIN','ADMIN','MANAGER','STAFF'].map((key) => [key,key]));
export const PERMISSIONS = [
  ['dashboard:access', 'Access dashboard', 'Sign in to the tenant dashboard.', Category.AUTH],
  ['admin_portal:access', 'Access admin portal', 'Access the system administration portal.', Category.ADMIN],
  ['tenant_account:lifecycle', 'Manage tenant lifecycle', 'Cancel or request deletion for a tenant account.', Category.ADMIN],
  ['auth:login_email', 'Email login', 'Authenticate with work email and one-time passcode.', Category.AUTH],
  ['auth:login_pin', 'PIN login', 'Authenticate with username and PIN.', Category.AUTH],
  ['auth:login_password', 'Password login', 'Authenticate with migrated username and password.', Category.AUTH],
  ['users:read', 'View staff', 'Read staff directory and user details.', Category.USERS],
  ['users:write', 'Create staff', 'Invite staff and update basic account details.', Category.USERS],
  ['users:admin', 'Administer staff', 'Reset login credentials and deactivate users.', Category.USERS],
  ['roles:read', 'View access roles', 'Read role and permission definitions.', Category.USERS],
  ['roles:write', 'Manage access roles', 'Create, edit, and delete tenant-defined roles.', Category.USERS],
  ['roles:assign', 'Assign access roles', 'Assign or revoke roles for staff members.', Category.USERS],
  ['locations:read', 'View locations', 'Read location records.', Category.LOCATIONS],
  ['locations:write', 'Manage locations', 'Create and update locations.', Category.LOCATIONS],
  ['locations:delete', 'Delete locations', 'Delete locations.', Category.LOCATIONS],
  ['shifts:read', 'View shifts', 'Read shifts.', Category.SHIFTS],
  ['shifts:write', 'Manage shifts', 'Create and update shifts.', Category.SHIFTS],
  ['shifts:delete', 'Delete shifts', 'Delete shifts.', Category.SHIFTS],
  ['schedules:read', 'View schedules', 'Read schedules.', Category.SCHEDULES],
  ['schedules:write', 'Manage schedules', 'Create and update schedules.', Category.SCHEDULES],
  ['schedules:publish', 'Publish schedules', 'Publish schedules.', Category.SCHEDULES],
  ['lunch_breaks:read', 'View breaks', 'Read lunch and break plans.', Category.LUNCH_BREAKS],
  ['lunch_breaks:write', 'Manage breaks', 'Create and update lunch and break plans.', Category.LUNCH_BREAKS],
  ['lunch_breaks:delete', 'Delete breaks', 'Delete lunch and break plans.', Category.LUNCH_BREAKS],
  ['notifications:read', 'View notifications', 'Read notifications.', Category.NOTIFICATIONS],
  ['notifications:write', 'Manage notifications', 'Create and mark notifications.', Category.NOTIFICATIONS],
  ['billing:read', 'View billing', 'Read billing and credits data.', Category.BILLING],
  ['billing:write', 'Manage billing', 'Modify billing and credits data.', Category.BILLING],
  ['settings:read', 'View settings', 'Read tenant settings.', Category.SETTINGS],
  ['settings:write', 'Manage settings', 'Update tenant settings.', Category.SETTINGS],
];

const ALL_PERMISSION_KEYS = PERMISSIONS.map(([key]) => key);
const CUSTOMER_ADMIN_EXCLUDED_PERMISSION_KEYS = new Set(['admin_portal:access']);
export const ROLE_DEFINITIONS = [
  { slug: 'super-admin', name: 'System Admin', legacyRole: LegacyRole.SUPER_ADMIN, permissions: ALL_PERMISSION_KEYS },
  {
    slug: 'admin',
    name: 'Admin',
    legacyRole: LegacyRole.ADMIN,
    isDefault: true,
    permissions: ALL_PERMISSION_KEYS.filter((key) => !CUSTOMER_ADMIN_EXCLUDED_PERMISSION_KEYS.has(key)),
  },
  {
    slug: 'manager',
    name: 'Manager',
    legacyRole: LegacyRole.MANAGER,
    permissions: [
      'dashboard:access',
      'auth:login_email',
      'auth:login_pin',
      'auth:login_password',
      'users:read',
      'users:write',
      'roles:read',
      'locations:read',
      'shifts:read',
      'shifts:write',
      'schedules:read',
      'schedules:write',
      'schedules:publish',
      'lunch_breaks:read',
      'lunch_breaks:write',
      'notifications:read',
      'notifications:write',
    ],
  },
  {
    slug: 'staff',
    name: 'Staff',
    legacyRole: LegacyRole.STAFF,
    permissions: [
      'dashboard:access',
      'auth:login_pin',
      'auth:login_password',
      'locations:read',
      'shifts:read',
      'schedules:read',
      'lunch_breaks:read',
      'notifications:read',
      'notifications:write',
    ],
  },
];


export const ADAPTER_VERSION = 'legacy-combined-v1';
export const DEFAULT_LIMITS = Object.freeze({ maxBytes: 16777216, maxRowsPerArray: 10000, maxTotalRows: 20000, maxStringLength: 2048, usernameCollisionLimit: 100, transactionTimeoutMs: 10000, transactionMaxWaitMs: 5000, maxDurationMs: 120000 });
const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const stable = (value) => JSON.stringify(value);
export const ROLE_PLAN_SHA256 = sha(stable({ permissions: PERMISSIONS, roles: ROLE_DEFINITIONS }));
const HEX = /^[0-9a-f]{64}(?![\s\S])/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/i;
function fail(message) { throw new Error(`Legacy import plan refused: ${message}`); }
function record(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
function exactKeys(value, keys, label) { record(value, label); if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(`${label} has unsupported or missing fields`); }
function digest(value, label) { if (typeof value !== 'string' || !HEX.test(value)) fail(`${label} must be lowercase SHA-256`); return value; }
export function freezePlan(value) { if (value && typeof value === 'object') { for (const child of Object.values(value)) freezePlan(child); Object.freeze(value); } return value; }
freezePlan(PERMISSIONS); freezePlan(ROLE_DEFINITIONS);
function id(value, label) {
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}(?![\s\S])/.test(raw) || BigInt(raw) > 4294967295n) fail(`${label} must be a canonical positive UINT32`);
  return raw;
}
function text(value, label, max, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is invalid or exceeds its bound`);
  return value;
}
function alias(row, first, second, fallback) {
  if (row[first] !== undefined && row[second] !== undefined && row[first] !== row[second]) fail(`conflicting ${first}/${second} aliases`);
  return row[first] ?? row[second] ?? fallback;
}
function username(value, fallback) { return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, '.').replace(/^\.+|\.+$/g, '').slice(0,48) || fallback; }
function parsed(bytes, label) {
  try { return record(JSON.parse(Buffer.from(bytes).toString('utf8').replace(/^\uFEFF/, '')), label); }
  catch (error) { if (error.message.startsWith('Legacy import plan refused:')) throw error; fail(`${label} is not valid JSON`); }
}
export function buildLegacyImportPlan(sourceBytes, descriptorBytes, { expectedDescriptorSha256, expectedSourceSha256 } = {}) {
  digest(expectedDescriptorSha256, 'external descriptor approval'); digest(expectedSourceSha256, 'external source approval');
  const approvalPlanSha256 = sha(descriptorBytes);
  if (approvalPlanSha256 !== expectedDescriptorSha256) fail('descriptor does not match external approval');
  if (Buffer.byteLength(sourceBytes) > DEFAULT_LIMITS.maxBytes || Buffer.byteLength(descriptorBytes) > 1048576) fail('input exceeds policy byte bound');
  const descriptor = parsed(descriptorBytes, 'descriptor');
  exactKeys(descriptor, ['schemaVersion','namespace','targetGenerationId','sourceSha256','adapterVersion','rolePlanSha256','companySlugs','timezone','limits'], 'descriptor');
  if (descriptor.schemaVersion !== 1 || descriptor.adapterVersion !== ADAPTER_VERSION) fail('unsupported descriptor or adapter version');
  if (typeof descriptor.namespace !== 'string' || !/^[a-z][a-z0-9._:-]{2,127}(?![\s\S])/.test(descriptor.namespace)) fail('namespace must be explicitly selected and canonical');
  if (typeof descriptor.targetGenerationId !== 'string' || !UUID.test(descriptor.targetGenerationId)) fail('target generation must be an admitted UUID');
  let timezone;
  try { timezone = new Intl.DateTimeFormat('en-US', { timeZone: text(descriptor.timezone, 'timezone', 100) }).resolvedOptions().timeZone; } catch { fail('timezone must be an admitted IANA identifier'); }
  if (timezone !== descriptor.timezone) fail('timezone must use its canonical IANA identifier');
  const sourceSha256 = sha(sourceBytes);
  if (digest(descriptor.sourceSha256, 'descriptor source digest') !== sourceSha256 || expectedSourceSha256 !== sourceSha256) fail('source does not match admitted digest');
  if (descriptor.rolePlanSha256 !== ROLE_PLAN_SHA256) fail('role plan does not match supported fixed plan');
  exactKeys(descriptor.limits, Object.keys(DEFAULT_LIMITS), 'limits');
  for (const [key, max] of Object.entries(DEFAULT_LIMITS)) if (!Number.isSafeInteger(descriptor.limits[key]) || descriptor.limits[key] < 1 || descriptor.limits[key] > max) fail(`limit ${key} is outside policy bounds`);
  const limits = { ...descriptor.limits };
  if (Buffer.byteLength(sourceBytes) > limits.maxBytes) fail('source exceeds admitted byte bound');
  const source = parsed(sourceBytes, 'source');
  const arrays = ['companies','stores','users','staff','user_company_roles','user_store_roles'];
  exactKeys(source, arrays, 'combined export');
  let total = 0;
  for (const key of arrays) { if (!Array.isArray(source[key]) || source[key].length > limits.maxRowsPerArray) fail(`${key} must be an in-bound array`); total += source[key].length; }
  if (total > limits.maxTotalRows) fail('export exceeds admitted total row bound');
  const rows = (key) => {
    const seen = new Set();
    return source[key].map((row) => { record(row, `${key} row`); const keyId = id(row.id, `${key}.id`); if (seen.has(keyId)) fail(`duplicate ${key} identity`); seen.add(keyId); return { row, id: keyId }; }).sort((a,b) => Number(a.id)-Number(b.id));
  };
  const companyRows = rows('companies');
  if (!companyRows.length) fail('at least one company is required');
  exactKeys(descriptor.companySlugs, companyRows.map((entry) => entry.id), 'companySlugs');
  const companyIds = new Set(companyRows.map((entry) => entry.id)); const usedSlugs = new Set();
  const companies = companyRows.map(({ row, id: companyId }) => {
    const slug = text(descriptor.companySlugs[companyId], 'company slug', 80);
    if (!/^legacy-company-[a-z0-9]+(?:-[a-z0-9]+)*(?![\s\S])/.test(slug) || usedSlugs.has(slug)) fail('company slugs must be unique canonical legacy-company slugs');
    usedSlugs.add(slug);
    return { id: companyId, slug, name: text(row.name, 'company name', limits.maxStringLength), rowSha256: sha(stable(row)) };
  });
  function company(row, label) { const value = id(row.company_id, `${label}.company_id`); if (!companyIds.has(value)) fail(`${label} has unknown company`); return value; }
  const storeRows = rows('stores');
  const storeCompanies = new Map();
  const locations = storeRows.map(({row,id: storeId}) => {
    const companyId = company(row,'store'); storeCompanies.set(storeId, companyId);
    return { id:storeId, companyId, name:text(row.name,'store name',limits.maxStringLength), address:text(row.location,'store location',limits.maxStringLength,{nullable:true}), timezone, rowSha256:sha(stable(row)) };
  });
  const userRows = rows('users'); const userCompanies = new Map(userRows.map(({row,id: userId}) => [userId,company(row,'user')]));
  const roleKeys = new Set(); const rolesByUser = new Map();
  for (const [array,association] of [['user_company_roles','company_id'],['user_store_roles','store_id']]) {
    for (const row of source[array]) {
      record(row,array); const userId=id(row.user_id,'role user_id'); const target=id(row[association],`role ${association}`);
      const companyId=association==='company_id'?target:storeCompanies.get(target);
      if (!userCompanies.has(userId) || !companyId || userCompanies.get(userId)!==companyId) fail('role association is absent or crosses company');
      if (!['super_admin','company_admin','store','schedule'].includes(row.role)) fail('unsupported legacy role');
      const key=stable([array,userId,target,row.role]); if(roleKeys.has(key)) fail('duplicate role association'); roleKeys.add(key);
      const list=rolesByUser.get(userId)??[]; list.push(row.role); rolesByUser.set(userId,list);
    }
  }
  const accounts = userRows.map(({row,id:userId}) => {
    const roles=rolesByUser.get(userId)??[]; const role=roles.includes('super_admin')||roles.includes('company_admin')?'ADMIN':roles.includes('store')||roles.includes('schedule')?'MANAGER':'STAFF';
    const sourceUsername=text(alias(row,'username_plain','username',`legacy.user.${userId}`),'username',limits.maxStringLength);
    const name=text(alias(row,'name_plain','name',sourceUsername),'user name',limits.maxStringLength);
    const passwordHash=text(alias(row,'password_hash','passwordHash',null),'password hash',255,{nullable:true});
    if(passwordHash && !/^\$2[aby]\$(?:0[4-9]|1[0-4])\$[./A-Za-z0-9]{53}(?![\s\S])/.test(passwordHash)) fail('unsupported preserved password hash');
    if(row.home_store_id!==undefined && storeCompanies.get(id(row.home_store_id,'home_store_id'))!==userCompanies.get(userId)) fail('user home store is absent or crosses company');
    return { id:userId, companyId:userCompanies.get(userId), sourceType:'user', name, usernameBase:username(sourceUsername,`legacy.user.${userId}`), email:/^[^\s@]+@[^\s@]+\.[^\s@]+(?![\s\S])/.test(sourceUsername)?sourceUsername.toLowerCase():null, passwordHash, role, note:roles.includes('super_admin')?'legacy_super_admin_downgraded_to_tenant_admin':'', rowSha256:sha(stable(row)) };
  });
  for(const {row,id:staffId} of rows('staff')) {
    const companyId=company(row,'staff');
    if(row.store_id!==undefined && row.store_id!==null && storeCompanies.get(id(row.store_id,'staff store_id'))!==companyId) fail('staff store is absent or crosses company');
    if(![0,1,'0','1'].includes(row.is_admin)) fail('staff is_admin must be exactly0 or1');
    const name=text(alias(row,'name_plain','name',`Staff ${staffId}`),'staff name',limits.maxStringLength);
    accounts.push({id:staffId,companyId,sourceType:'staff',name,usernameBase:username(name,`staff.${staffId}`),email:null,passwordHash:null,role:Number(row.is_admin)===1?'ADMIN':'STAFF',note:'',rowSha256:sha(stable(row))});
  }
  return freezePlan({ namespace:descriptor.namespace,generationUuid:descriptor.targetGenerationId.toLowerCase(),sourceSha256,adapterVersion:ADAPTER_VERSION,rolePlanSha256:ROLE_PLAN_SHA256,approvalPlanSha256,timezone,limits,counts:{company:companies.length,location:locations.length,user:userRows.length,staff:accounts.length-userRows.length},companies,locations,accounts });
}
