import { describe, expect, it } from 'vitest';

import { buildStaffActionConfirmation } from '../../app/dashboard/staff/staff-action-confirmation';

describe('staff destructive action confirmations', () => {
  it('warns that a PIN reset invalidates the existing PIN access', () => {
    const confirmation = buildStaffActionConfirmation('reset-pin', {
      name: 'Morgan Lee',
      username: 'morgan.lee',
    });

    expect(confirmation.title).toBe('Reset PIN for Morgan Lee?');
    expect(confirmation.description).toContain('Morgan Lee (morgan.lee)');
    expect(confirmation.description).toContain('signed out of PIN access');
    expect(confirmation.confirmLabel).toBe('Reset PIN');
  });

  it('warns that staff removal immediately revokes workspace access', () => {
    const confirmation = buildStaffActionConfirmation('remove', { name: 'Jordan Kim' });

    expect(confirmation.title).toBe('Remove Jordan Kim?');
    expect(confirmation.description).toContain('immediately lose access');
    expect(confirmation.confirmLabel).toBe('Remove staff member');
  });
});
