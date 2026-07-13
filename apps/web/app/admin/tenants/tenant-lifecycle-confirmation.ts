export type TenantLifecycleAction = 'suspend' | 'archive' | 'delete';

export type TenantLifecyclePromptTenant = {
  name: string;
  slug: string;
};

export type TenantLifecycleConfirmation = {
  expectedInput: string;
  prompt: string;
};

const ACTION_COPY: Record<TenantLifecycleAction, { label: string; impact: string }> = {
  suspend: {
    label: 'Suspend',
    impact: 'Users may lose workspace access until the tenant is activated again.',
  },
  archive: {
    label: 'Archive',
    impact: 'The tenant will leave the active directory and must be restored before it can be used again.',
  },
  delete: {
    label: 'Permanently delete',
    impact: 'This removes the archived tenant record through the admin API and cannot be undone from this screen.',
  },
};

export function buildTenantLifecycleConfirmation(
  action: TenantLifecycleAction,
  tenant: TenantLifecyclePromptTenant,
): TenantLifecycleConfirmation {
  const copy = ACTION_COPY[action];
  const expectedInput = tenant.slug.trim();

  return {
    expectedInput,
    prompt: [
      `${copy.label} ${tenant.name}?`,
      copy.impact,
      `Type ${expectedInput} to confirm.`,
    ].join('\n\n'),
  };
}

export function buildBulkTenantDeleteConfirmation(count: number): TenantLifecycleConfirmation {
  const expectedInput = `DELETE ${count}`;

  return {
    expectedInput,
    prompt: [
      `Permanently delete ${count} archived tenant${count === 1 ? '' : 's'}?`,
      'This removes each archived tenant through the admin API and cannot be undone from this screen.',
      `Type ${expectedInput} to confirm.`,
    ].join('\n\n'),
  };
}

export function lifecycleConfirmationMatches(input: string | null | undefined, expectedInput: string): boolean {
  return input?.trim() === expectedInput;
}
