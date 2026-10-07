export type TenantStatusAction = 'suspend' | 'activate' | 'archive' | 'restore';
export type TenantLifecycleOutcome = 'completed' | 'incomplete' | 'unconfirmed';

// All four retained native POST handlers return 201. An acknowledgement belongs
// to the captured target and action, not a later selection or an optimistic row.
// Archive alone has a supported negative outcome; the other handlers either
// confirm their literal result or refuse the request.
export function tenantLifecycleOutcome(
  action: TenantStatusAction,
  targetId: string,
  status: number,
  value: unknown,
): TenantLifecycleOutcome {
  if (status !== 201 || !targetId || value === null || typeof value !== 'object'
    || Array.isArray(value) || !('id' in value) || value.id !== targetId) return 'unconfirmed';

  switch (action) {
    case 'suspend':
      return 'status' in value && value.status === 'SUSPENDED' ? 'completed' : 'unconfirmed';
    case 'activate':
      return 'status' in value && value.status === 'ACTIVE' ? 'completed' : 'unconfirmed';
    case 'archive':
      if (!('archived' in value)) return 'unconfirmed';
      if (value.archived === true) return 'completed';
      return value.archived === false ? 'incomplete' : 'unconfirmed';
    case 'restore':
      return 'restored' in value && value.restored === true ? 'completed' : 'unconfirmed';
    default:
      return 'unconfirmed';
  }
}
