/**
 * Permissions that require a completed MFA challenge before they can be used.
 *
 * This list is intentionally independent from the database seed so both the
 * legacy API and API v2 make the same session-boundary decision while role
 * assignments are read from the tenant database.
 */
export const MFA_REQUIRED_PERMISSION_KEYS = [
  'admin_portal:access',
  'tenant_account:lifecycle',
  'account:data_export',
  'users:write',
  'users:admin',
  'roles:write',
  'roles:assign',
  'time_cards:approve',
  'payroll:read',
  'payroll:policy_write',
  'payroll:lock',
  'payroll:export',
  'payroll:reconcile',
  'billing:write',
  'settings:write',
] as const;

export const PRIVILEGED_MFA_PERMISSION_KEYS: ReadonlySet<string> = new Set(
  MFA_REQUIRED_PERMISSION_KEYS,
);
