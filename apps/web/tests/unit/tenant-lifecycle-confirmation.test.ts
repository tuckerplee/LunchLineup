import { describe, expect, it } from 'vitest';

import {
  buildBulkTenantDeleteConfirmation,
  buildTenantLifecycleConfirmation,
  lifecycleConfirmationMatches,
} from '../../app/admin/tenants/tenant-lifecycle-confirmation';

describe('tenant lifecycle confirmation helpers', () => {
  it('requires the exact tenant slug for destructive lifecycle actions', () => {
    const confirmation = buildTenantLifecycleConfirmation('archive', {
      name: 'Downtown Bistro',
      slug: 'downtown-bistro',
    });

    expect(confirmation.expectedInput).toBe('downtown-bistro');
    expect(confirmation.prompt).toContain('Archive Downtown Bistro?');
    expect(confirmation.prompt).toContain('Type downtown-bistro to confirm.');
    expect(lifecycleConfirmationMatches('downtown-bistro', confirmation.expectedInput)).toBe(true);
    expect(lifecycleConfirmationMatches('Downtown-Bistro', confirmation.expectedInput)).toBe(false);
    expect(lifecycleConfirmationMatches(null, confirmation.expectedInput)).toBe(false);
  });

  it('requires an explicit bulk delete phrase for archived tenant cleanup', () => {
    const confirmation = buildBulkTenantDeleteConfirmation(3);

    expect(confirmation.expectedInput).toBe('DELETE 3');
    expect(confirmation.prompt).toContain('Permanently delete 3 archived tenants?');
    expect(lifecycleConfirmationMatches('DELETE 3', confirmation.expectedInput)).toBe(true);
    expect(lifecycleConfirmationMatches('delete 3', confirmation.expectedInput)).toBe(false);
  });
});
