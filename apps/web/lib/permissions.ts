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

export function getWorkspaceCapabilities(permissions: PermissionList): WorkspaceCapabilities {
  const hasAdminPortal = hasPermission(permissions, 'admin_portal:access');

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
  };
}
