export type ApplicationApiMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export type ApplicationApiResponseKind = 'json' | 'download' | 'redirect';

export type ApplicationApiOperation = Readonly<{
  operationId: string;
  method: ApplicationApiMethod;
  path: string;
  tag:
    | 'Authentication'
    | 'Locations'
    | 'People'
    | 'Operations'
    | 'Time'
    | 'Payroll'
    | 'Notifications'
    | 'Settings'
    | 'Billing'
    | 'Imports'
    | 'Administration';
  summary: string;
  responseKind?: ApplicationApiResponseKind;
  bodyLimitBytes?: number;
  /** Native API-02 route registration owns this operation instead of the retained bridge. */
  native?: true;
}>;

const MiB = 1024 * 1024;

/**
 * Browser-facing API-01 operations that retain a mature v1 implementation
 * behind the API-v2 service while API-02 replaces those implementations.
 *
 * This is intentionally an exact route catalog. It is shared by the server
 * registrar and browser transport so neither side can turn it into a wildcard
 * v1 proxy.
 */
export const APPLICATION_API_OPERATIONS = [
  { operationId: 'resolveLoginMethod', method: 'POST', path: '/auth/login/resolve', tag: 'Authentication', summary: 'Resolve the configured sign-in method' },
  { operationId: 'verifyPasswordLogin', method: 'POST', path: '/auth/password/verify', tag: 'Authentication', summary: 'Verify a password sign-in challenge' },
  { operationId: 'requestPasswordReset', method: 'POST', path: '/auth/password/reset/request', tag: 'Authentication', summary: 'Request password recovery' },
  { operationId: 'confirmPasswordReset', method: 'POST', path: '/auth/password/reset/confirm', tag: 'Authentication', summary: 'Confirm password recovery' },
  { operationId: 'startOidcLogin', method: 'GET', path: '/auth/login', tag: 'Authentication', summary: 'Start an OIDC sign-in redirect', responseKind: 'redirect' },
  { operationId: 'completeOidcLogin', method: 'GET', path: '/auth/callback', tag: 'Authentication', summary: 'Complete an OIDC sign-in redirect', responseKind: 'redirect' },
  { operationId: 'sendEmailLoginCode', method: 'POST', path: '/auth/email/send-otp', tag: 'Authentication', summary: 'Send an email sign-in code' },
  { operationId: 'verifyEmailLoginCode', method: 'POST', path: '/auth/email/verify-otp', tag: 'Authentication', summary: 'Verify an email sign-in code' },
  { operationId: 'verifyPinLogin', method: 'POST', path: '/auth/pin/verify', tag: 'Authentication', summary: 'Verify a PIN sign-in challenge' },
  { operationId: 'refreshSession', method: 'POST', path: '/auth/refresh', tag: 'Authentication', summary: 'Rotate the authenticated session' },
  { operationId: 'getMfaEnrollment', method: 'GET', path: '/auth/mfa/enrollment', tag: 'Authentication', summary: 'Read MFA enrollment state' },
  { operationId: 'startMfaEnrollment', method: 'POST', path: '/auth/mfa/enrollment', tag: 'Authentication', summary: 'Start MFA enrollment' },
  { operationId: 'confirmMfaEnrollment', method: 'PUT', path: '/auth/mfa/enrollment', tag: 'Authentication', summary: 'Confirm MFA enrollment' },
  { operationId: 'deleteMfaEnrollment', method: 'DELETE', path: '/auth/mfa/enrollment', tag: 'Authentication', summary: 'Disable MFA enrollment' },
  { operationId: 'verifyMfaChallenge', method: 'POST', path: '/auth/mfa/verify', tag: 'Authentication', summary: 'Verify an MFA sign-in challenge' },
  { operationId: 'deleteSession', method: 'POST', path: '/auth/logout', tag: 'Authentication', summary: 'Revoke the authenticated session' },
  { operationId: 'getCurrentSession', method: 'GET', path: '/auth/me', tag: 'Authentication', summary: 'Read the authenticated identity and permissions', native: true },

  { operationId: 'listLocations', method: 'GET', path: '/locations', tag: 'Locations', summary: 'List active locations', native: true },
  { operationId: 'createLocation', method: 'POST', path: '/locations', tag: 'Locations', summary: 'Create a location', native: true },
  { operationId: 'getLocationSummary', method: 'GET', path: '/locations/summary', tag: 'Locations', summary: 'Read the location summary', native: true },
  { operationId: 'getLocation', method: 'GET', path: '/locations/:locationId', tag: 'Locations', summary: 'Read one location', native: true },
  { operationId: 'updateLocation', method: 'PUT', path: '/locations/:locationId', tag: 'Locations', summary: 'Replace one location', native: true },
  { operationId: 'deleteLocation', method: 'DELETE', path: '/locations/:locationId', tag: 'Locations', summary: 'Archive one location', native: true },

  { operationId: 'listStaffMembers', method: 'GET', path: '/users', tag: 'People', summary: 'List staff members', native: true },
  { operationId: 'getAccessCatalog', method: 'GET', path: '/users/access/catalog', tag: 'People', summary: 'Read the access-role catalog', native: true },
  { operationId: 'getStaffSchedulingProfile', method: 'GET', path: '/users/:userId/scheduling-profile', tag: 'People', summary: 'Read one staff scheduling profile', native: true },
  { operationId: 'updateStaffSchedulingProfile', method: 'PUT', path: '/users/:userId/scheduling-profile', tag: 'People', summary: 'Replace one staff scheduling profile', native: true },
  { operationId: 'getStaffMember', method: 'GET', path: '/users/:userId', tag: 'People', summary: 'Read one staff member', native: true },
  { operationId: 'createStaffInvitation', method: 'POST', path: '/users/invite', tag: 'People', summary: 'Invite a staff member', native: true },
  { operationId: 'getStaffInvitation', method: 'GET', path: '/users/:userId/invitation', tag: 'People', summary: 'Read invitation delivery state', native: true },
  { operationId: 'retryStaffInvitation', method: 'POST', path: '/users/:userId/invitation/retry', tag: 'People', summary: 'Retry invitation delivery', native: true },
  { operationId: 'reissueStaffInvitation', method: 'POST', path: '/users/:userId/invitation/reissue', tag: 'People', summary: 'Reissue an invitation', native: true },
  { operationId: 'resetStaffPin', method: 'POST', path: '/users/:userId/pin/reset', tag: 'People', summary: 'Reset a staff PIN', native: true },
  { operationId: 'replaceCurrentPin', method: 'PUT', path: '/users/me/pin', tag: 'People', summary: 'Replace the current user PIN', native: true },
  { operationId: 'deleteStaffMember', method: 'DELETE', path: '/users/:userId', tag: 'People', summary: 'Deactivate a staff member' },
  { operationId: 'getStaffAccess', method: 'GET', path: '/users/:userId/access', tag: 'People', summary: 'Read one staff access assignment', native: true },
  { operationId: 'updateStaffAccess', method: 'PUT', path: '/users/:userId/access', tag: 'People', summary: 'Replace one staff access assignment', native: true },
  { operationId: 'createAccessRole', method: 'POST', path: '/users/roles', tag: 'People', summary: 'Create an access role', native: true },
  { operationId: 'updateAccessRole', method: 'PUT', path: '/users/roles/:roleId', tag: 'People', summary: 'Replace an access role', native: true },
  { operationId: 'deleteAccessRole', method: 'DELETE', path: '/users/roles/:roleId', tag: 'People', summary: 'Delete an access role', native: true },

  { operationId: 'listScheduleSummaries', method: 'GET', path: '/schedules', tag: 'Operations', summary: 'List schedule summaries', native: true },
  { operationId: 'listShiftSummaries', method: 'GET', path: '/shifts', tag: 'Operations', summary: 'List shift summaries', native: true },
  { operationId: 'listStaffRoster', method: 'GET', path: '/shifts/staff-roster', tag: 'Operations', summary: 'List the bounded scheduling roster', native: true },
  { operationId: 'listLunchBreakRows', method: 'GET', path: '/lunch-breaks', tag: 'Operations', summary: 'List lunch and break rows', native: true },
  { operationId: 'getLunchBreakPolicy', method: 'GET', path: '/lunch-breaks/policy', tag: 'Operations', summary: 'Read the lunch and break policy', native: true },
  { operationId: 'updateLunchBreakPolicy', method: 'PUT', path: '/lunch-breaks/policy', tag: 'Operations', summary: 'Replace the lunch and break policy', native: true },
  { operationId: 'generateLunchBreakPlan', method: 'POST', path: '/lunch-breaks/generate', tag: 'Operations', summary: 'Generate one lunch and break plan', native: true },
  { operationId: 'importLunchBreakShifts', method: 'POST', path: '/lunch-breaks/setup-shifts', tag: 'Operations', summary: 'Import manual shifts into a break plan', native: true },
  { operationId: 'updateShiftBreakPlan', method: 'PUT', path: '/lunch-breaks/shift/:shiftId', tag: 'Operations', summary: 'Replace one shift break plan', native: true },

  { operationId: 'listTimeCards', method: 'GET', path: '/time-cards', tag: 'Time', summary: 'List time cards', native: true },
  { operationId: 'getActiveTimeCard', method: 'GET', path: '/time-cards/active', tag: 'Time', summary: 'Read the active time card', native: true },
  { operationId: 'getTimeCard', method: 'GET', path: '/time-cards/:timeCardId', tag: 'Time', summary: 'Read one time card', native: true },
  { operationId: 'clockIn', method: 'POST', path: '/time-cards/clock-in', tag: 'Time', summary: 'Create a clock-in event', native: true },
  { operationId: 'clockOut', method: 'POST', path: '/time-cards/:timeCardId/clock-out', tag: 'Time', summary: 'Create a clock-out event', native: true },
  { operationId: 'correctTimeCard', method: 'PATCH', path: '/time-cards/:timeCardId/correction', tag: 'Time', summary: 'Correct a time card', native: true },

  { operationId: 'getPayrollExportEntitlement', method: 'GET', path: '/payroll/export-entitlement', tag: 'Payroll', summary: 'Read payroll export entitlement' },
  { operationId: 'listPayrollPolicies', method: 'GET', path: '/payroll/policies', tag: 'Payroll', summary: 'List payroll policy versions' },
  { operationId: 'getPayrollPolicy', method: 'GET', path: '/payroll/policy', tag: 'Payroll', summary: 'Read the current payroll policy' },
  { operationId: 'createPayrollPolicy', method: 'PUT', path: '/payroll/policy', tag: 'Payroll', summary: 'Create a payroll policy version' },
  { operationId: 'listPayrollPeriods', method: 'GET', path: '/payroll/periods', tag: 'Payroll', summary: 'List payroll periods' },
  { operationId: 'createPayrollPeriod', method: 'POST', path: '/payroll/periods', tag: 'Payroll', summary: 'Create a payroll period' },
  { operationId: 'getPayrollPeriod', method: 'GET', path: '/payroll/periods/:periodId', tag: 'Payroll', summary: 'Read one payroll period' },
  { operationId: 'adoptPayrollTimeCards', method: 'POST', path: '/payroll/periods/:periodId/adopt', tag: 'Payroll', summary: 'Adopt time cards into a payroll period' },
  { operationId: 'startPayrollReview', method: 'POST', path: '/payroll/periods/:periodId/review', tag: 'Payroll', summary: 'Start payroll review' },
  { operationId: 'decidePayrollEntries', method: 'POST', path: '/payroll/periods/:periodId/decisions', tag: 'Payroll', summary: 'Record payroll entry decisions' },
  { operationId: 'lockPayrollPeriod', method: 'POST', path: '/payroll/periods/:periodId/lock', tag: 'Payroll', summary: 'Lock a payroll period' },
  { operationId: 'createPayrollAmendment', method: 'POST', path: '/payroll/entries/:entryId/amendments', tag: 'Payroll', summary: 'Create a payroll amendment' },
  { operationId: 'decidePayrollAmendment', method: 'POST', path: '/payroll/amendments/:amendmentId/decision', tag: 'Payroll', summary: 'Decide a payroll amendment' },
  { operationId: 'createPayrollExport', method: 'POST', path: '/payroll/periods/:periodId/exports', tag: 'Payroll', summary: 'Create a payroll export' },
  { operationId: 'getPayrollExport', method: 'GET', path: '/payroll/exports/:exportId', tag: 'Payroll', summary: 'Read one payroll export' },
  { operationId: 'downloadPayrollExport', method: 'GET', path: '/payroll/exports/:exportId/download', tag: 'Payroll', summary: 'Download one payroll export', responseKind: 'download', bodyLimitBytes: 25 * MiB },
  { operationId: 'reconcilePayrollExport', method: 'POST', path: '/payroll/exports/:exportId/reconciliation', tag: 'Payroll', summary: 'Reconcile a payroll export' },

  { operationId: 'listNotifications', method: 'GET', path: '/notifications', tag: 'Notifications', summary: 'List notifications' },
  { operationId: 'markNotificationRead', method: 'POST', path: '/notifications/read', tag: 'Notifications', summary: 'Mark one notification read' },
  { operationId: 'markAllNotificationsRead', method: 'POST', path: '/notifications/read-all', tag: 'Notifications', summary: 'Mark all notifications read' },

  { operationId: 'getWorkspaceSettings', method: 'GET', path: '/settings', tag: 'Settings', summary: 'Read workspace settings' },
  { operationId: 'updateGeneralSettings', method: 'PUT', path: '/settings/general', tag: 'Settings', summary: 'Replace general workspace settings' },
  { operationId: 'updateTeamSettings', method: 'PUT', path: '/settings/team', tag: 'Settings', summary: 'Replace team workspace settings' },
  { operationId: 'updateSecuritySettings', method: 'PUT', path: '/settings/security', tag: 'Settings', summary: 'Replace security workspace settings' },

  { operationId: 'getBillingFeatures', method: 'GET', path: '/billing/features', tag: 'Billing', summary: 'Read billing features and entitlements' },
  { operationId: 'getSubscriptionRecoveryAction', method: 'GET', path: '/billing/subscription-recovery-action', tag: 'Billing', summary: 'Read the subscription recovery action' },
  { operationId: 'listBillingPriceOptions', method: 'GET', path: '/billing/price-options', tag: 'Billing', summary: 'List subscription price options' },
  { operationId: 'listCreditPacks', method: 'GET', path: '/billing/credit-packs', tag: 'Billing', summary: 'List credit packs' },
  { operationId: 'createCreditPackCheckout', method: 'POST', path: '/billing/credit-packs/checkout', tag: 'Billing', summary: 'Create a credit-pack checkout' },
  { operationId: 'createSubscriptionCheckout', method: 'POST', path: '/billing/subscribe', tag: 'Billing', summary: 'Create a subscription checkout' },
  { operationId: 'createBillingPortalSession', method: 'POST', path: '/billing/portal', tag: 'Billing', summary: 'Create a billing portal session' },
  { operationId: 'changeSubscriptionPlan', method: 'POST', path: '/billing/change-plan', tag: 'Billing', summary: 'Change the subscription plan' },
  { operationId: 'resumeSubscription', method: 'POST', path: '/billing/resume', tag: 'Billing', summary: 'Resume a subscription' },

  { operationId: 'createAvailabilityImport', method: 'POST', path: '/availability-imports/users/:userId', tag: 'Imports', summary: 'Create a staff availability import', bodyLimitBytes: 10 * MiB },
  { operationId: 'getAvailabilityImport', method: 'GET', path: '/availability-imports/:importId', tag: 'Imports', summary: 'Read one availability import' },

  { operationId: 'getAdminStats', method: 'GET', path: '/admin/stats', tag: 'Administration', summary: 'Read platform statistics' },
  { operationId: 'listAdminTenants', method: 'GET', path: '/admin/tenants', tag: 'Administration', summary: 'List platform tenants' },
  { operationId: 'createAdminTenant', method: 'POST', path: '/admin/tenants', tag: 'Administration', summary: 'Create a platform tenant' },
  { operationId: 'updateAdminTenant', method: 'PUT', path: '/admin/tenants/:tenantId', tag: 'Administration', summary: 'Replace a platform tenant' },
  { operationId: 'suspendAdminTenant', method: 'POST', path: '/admin/tenants/:tenantId/suspend', tag: 'Administration', summary: 'Suspend a platform tenant' },
  { operationId: 'activateAdminTenant', method: 'POST', path: '/admin/tenants/:tenantId/activate', tag: 'Administration', summary: 'Activate a platform tenant' },
  { operationId: 'archiveAdminTenant', method: 'POST', path: '/admin/tenants/:tenantId/archive', tag: 'Administration', summary: 'Archive a platform tenant' },
  { operationId: 'restoreAdminTenant', method: 'POST', path: '/admin/tenants/:tenantId/restore', tag: 'Administration', summary: 'Restore a platform tenant' },
  { operationId: 'deleteAdminTenant', method: 'DELETE', path: '/admin/tenants/:tenantId', tag: 'Administration', summary: 'Permanently delete an eligible platform tenant' },
  { operationId: 'createAccountExport', method: 'POST', path: '/admin/account/export', tag: 'Administration', summary: 'Create a tenant account export' },
  { operationId: 'listAccountExports', method: 'GET', path: '/admin/account/exports', tag: 'Administration', summary: 'List tenant account exports' },
  { operationId: 'getAccountExport', method: 'GET', path: '/admin/account/exports/:jobId', tag: 'Administration', summary: 'Read one tenant account export' },
  { operationId: 'downloadAccountExport', method: 'GET', path: '/admin/account/exports/:jobId/download', tag: 'Administration', summary: 'Download one tenant account export', responseKind: 'download', bodyLimitBytes: 25 * MiB },
  { operationId: 'getAccountLifecycleStatus', method: 'GET', path: '/admin/account/status', tag: 'Administration', summary: 'Read tenant account lifecycle status' },
  { operationId: 'cancelAccountRenewal', method: 'POST', path: '/admin/account/cancel', tag: 'Administration', summary: 'Cancel tenant subscription renewal' },
  { operationId: 'deleteTenantAccount', method: 'DELETE', path: '/admin/account', tag: 'Administration', summary: 'Request tenant account deletion' },
  { operationId: 'listAdminUsers', method: 'GET', path: '/admin/users', tag: 'Administration', summary: 'List platform users' },
  { operationId: 'updateAdminUser', method: 'PUT', path: '/admin/users/:userId', tag: 'Administration', summary: 'Replace a platform user' },
  { operationId: 'resetAdminUserMfa', method: 'POST', path: '/admin/users/:userId/mfa/reset', tag: 'Administration', summary: 'Reset platform-user MFA' },
  { operationId: 'lockAdminUser', method: 'POST', path: '/admin/users/:userId/lock', tag: 'Administration', summary: 'Lock a platform user' },
  { operationId: 'unlockAdminUser', method: 'POST', path: '/admin/users/:userId/unlock', tag: 'Administration', summary: 'Unlock a platform user' },
  { operationId: 'suspendAdminUser', method: 'POST', path: '/admin/users/:userId/suspend', tag: 'Administration', summary: 'Suspend a platform user' },
  { operationId: 'activateAdminUser', method: 'POST', path: '/admin/users/:userId/activate', tag: 'Administration', summary: 'Activate a platform user' },
  { operationId: 'listAdminAudit', method: 'GET', path: '/admin/audit', tag: 'Administration', summary: 'List platform audit events' },
  { operationId: 'getAdminCredits', method: 'GET', path: '/admin/credits', tag: 'Administration', summary: 'Read platform credit balances and history' },
  { operationId: 'grantAdminCredits', method: 'POST', path: '/admin/credits/grant', tag: 'Administration', summary: 'Grant tenant credits' },
  { operationId: 'listAdminPlans', method: 'GET', path: '/admin/plans', tag: 'Administration', summary: 'List billing plans' },
  { operationId: 'createAdminPlan', method: 'POST', path: '/admin/plans', tag: 'Administration', summary: 'Create a billing plan' },
  { operationId: 'updateAdminPlan', method: 'PUT', path: '/admin/plans/:codeOrId', tag: 'Administration', summary: 'Replace a billing plan' },
  { operationId: 'deleteAdminPlan', method: 'DELETE', path: '/admin/plans/:codeOrId', tag: 'Administration', summary: 'Delete a billing plan' },
  { operationId: 'getAdminHealth', method: 'GET', path: '/admin/health', tag: 'Administration', summary: 'Read platform dependency health' },
] as const satisfies readonly ApplicationApiOperation[];

const operationMatchers = APPLICATION_API_OPERATIONS.map((operation) => {
  const pattern = operation.path
    .split('/')
    .map((segment) => (segment.startsWith(':') ? '[^/]+' : segment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    .join('/');
  return {
    operation,
    matcher: new RegExp(`^${pattern}$`),
  };
});

function normalizedLogicalPath(value: string): string | null {
  if (
    !value.startsWith('/')
    || value.startsWith('//')
    || value.includes('\\')
    || /[\u0000-\u001f\u007f]/.test(value)
    || /^[a-z][a-z\d+.-]*:/i.test(value)
  ) {
    return null;
  }
  const queryIndex = value.indexOf('?');
  const pathname = queryIndex === -1 ? value : value.slice(0, queryIndex);
  try {
    const decoded = decodeURIComponent(pathname);
    if (
      decoded.includes('..')
      || decoded.includes('\\')
      || decoded.includes('//')
      || decoded.split('/').length !== pathname.split('/').length
      || /[\u0000-\u001f\u007f]/.test(decoded)
    ) return null;
  } catch {
    return null;
  }
  return pathname;
}

export function applicationApiOperation(
  path: string,
  method?: ApplicationApiMethod,
): ApplicationApiOperation | null {
  const pathname = normalizedLogicalPath(path);
  if (!pathname) return null;
  return operationMatchers.find(({ operation, matcher }) => (
    (method === undefined || operation.method === method) && matcher.test(pathname)
  ))?.operation ?? null;
}
