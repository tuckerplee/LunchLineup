import { describe, expect, it } from 'vitest';

import {
  buildRoleDeletionConfirmation,
  canConfirmRoleDeletion,
} from '../../app/dashboard/staff/role-deletion-confirmation';

describe('custom role deletion confirmation', () => {
  it('requires the exact role name when no assignments exist', () => {
    const confirmation = buildRoleDeletionConfirmation({ name: 'Weekend Lead', userCount: 0 });

    expect(confirmation.description).toContain('0 assignments');
    expect(canConfirmRoleDeletion(confirmation, 'weekend lead')).toBe(false);
    expect(canConfirmRoleDeletion(confirmation, 'Weekend Lead')).toBe(true);
  });

  it('blocks deletion and reports the affected assignment count', () => {
    const confirmation = buildRoleDeletionConfirmation({ name: 'Closer', userCount: 2 });

    expect(confirmation.description).toContain('2 assignments');
    expect(confirmation.description).toContain('Reassign');
    expect(canConfirmRoleDeletion(confirmation, 'Closer')).toBe(false);
  });
});
