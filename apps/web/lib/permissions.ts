export type PermissionList = readonly string[] | null | undefined;

export const SCHEDULING_READ_PERMISSIONS = [
  'schedules:read',
  'shifts:read',
  'locations:read',
] as const;

export const LUNCH_BREAK_READ_PERMISSIONS = [
  'lunch_breaks:read',
  'locations:read',
] as const;

export const PAYROLL_PERMISSIONS = {
  read: 'payroll:read',
  policyWrite: 'payroll:policy_write',
  lock: 'payroll:lock',
  decide: 'time_cards:approve',
  export: 'payroll:export',
  reconcile: 'payroll:reconcile',
} as const;

export type PayrollCapabilities = {
  canReadPayroll: boolean;
  canWritePayrollPolicy: boolean;
  canLockPayroll: boolean;
  canApprovePayrollTimeCards: boolean;
  canExportPayroll: boolean;
  canReconcilePayroll: boolean;
};

export type WorkspaceCapabilities = {
  hasAdminPortal: boolean;
  canReadScheduling: boolean;
  canWriteSchedules: boolean;
  canWriteShifts: boolean;
  canDeleteShifts: boolean;
  canPublishSchedules: boolean;
  canReadLunchBreaks: boolean;
  canWriteLunchBreaks: boolean;
  canReadUsers: boolean;
  canWriteUsers: boolean;
  canReadLocations: boolean;
  canWriteLocations: boolean;
  canReadSettings: boolean;
  canWriteSettings: boolean;
  canReadBilling: boolean;
  canWriteBilling: boolean;
  canManageAccountLifecycle: boolean;
  canReadTimeCards: boolean;
  canWriteTimeCards: boolean;
  canReadPayroll: boolean;
  canWritePayrollPolicy: boolean;
  canLockPayroll: boolean;
  canApprovePayrollTimeCards: boolean;
  canExportPayroll: boolean;
  canReconcilePayroll: boolean;
};

export function hasPermission(permissions: PermissionList, permission: string): boolean {
  return Array.isArray(permissions) && permissions.includes(permission);
}

export function hasAnyPermission(permissions: PermissionList, candidates: string[]): boolean {
  return candidates.some((permission) => hasPermission(permissions, permission));
}

export function hasSchedulingReadAccess(permissions: PermissionList): boolean {
  return SCHEDULING_READ_PERMISSIONS.every((permission) => hasPermission(permissions, permission));
}

export function hasLunchBreakReadAccess(permissions: PermissionList): boolean {
  return LUNCH_BREAK_READ_PERMISSIONS.every((permission) => hasPermission(permissions, permission));
}

export function getPayrollCapabilities(permissions: PermissionList): PayrollCapabilities {
  return {
    canReadPayroll: hasPermission(permissions, PAYROLL_PERMISSIONS.read),
    canWritePayrollPolicy: hasPermission(permissions, PAYROLL_PERMISSIONS.policyWrite),
    canLockPayroll: hasPermission(permissions, PAYROLL_PERMISSIONS.lock),
    canApprovePayrollTimeCards: hasPermission(permissions, PAYROLL_PERMISSIONS.decide),
    canExportPayroll: hasPermission(permissions, PAYROLL_PERMISSIONS.export),
    canReconcilePayroll: hasPermission(permissions, PAYROLL_PERMISSIONS.reconcile),
  };
}

export function getWorkspaceCapabilities(permissions: PermissionList): WorkspaceCapabilities {
  const hasAdminPortal = hasPermission(permissions, 'admin_portal:access');
  const payroll = getPayrollCapabilities(permissions);

  return {
    hasAdminPortal,
    canReadScheduling: hasSchedulingReadAccess(permissions),
    canWriteSchedules: hasPermission(permissions, 'schedules:write'),
    canWriteShifts: hasPermission(permissions, 'shifts:write'),
    canDeleteShifts: hasPermission(permissions, 'shifts:delete'),
    canPublishSchedules: hasPermission(permissions, 'schedules:publish'),
    canReadLunchBreaks: hasLunchBreakReadAccess(permissions),
    canWriteLunchBreaks: hasPermission(permissions, 'lunch_breaks:write'),
    canReadUsers: hasPermission(permissions, 'users:read'),
    canWriteUsers: hasPermission(permissions, 'users:write'),
    canReadLocations: hasPermission(permissions, 'locations:read'),
    canWriteLocations: hasPermission(permissions, 'locations:write'),
    canReadSettings: hasPermission(permissions, 'settings:read'),
    canWriteSettings: hasPermission(permissions, 'settings:write'),
    canReadBilling: hasPermission(permissions, 'billing:read'),
    canWriteBilling: hasPermission(permissions, 'billing:write'),
    canManageAccountLifecycle: hasPermission(permissions, 'tenant_account:lifecycle'),
    canReadTimeCards: hasPermission(permissions, 'time_cards:read'),
    canWriteTimeCards: hasPermission(permissions, 'time_cards:write'),
    ...payroll,
  };
}
