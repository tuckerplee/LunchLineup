import { beforeEach, describe, expect, it, vi } from 'vitest';

const { redirectMock, requireAuthMock } = vi.hoisted(() => ({
  redirectMock: vi.fn(),
  requireAuthMock: vi.fn(),
}));

vi.mock('next/navigation', () => ({ redirect: redirectMock }));
vi.mock('../../lib/server-auth', () => ({ requireAuth: requireAuthMock }));

import SchedulingLayout from '../../app/dashboard/scheduling/layout';

describe('scheduling route access', () => {
  beforeEach(() => {
    redirectMock.mockReset();
    redirectMock.mockImplementation(() => {
      throw new Error('NEXT_REDIRECT');
    });
    requireAuthMock.mockReset();
  });

  it('renders only when every required scheduling read is effective', async () => {
    requireAuthMock.mockResolvedValue({
      permissions: ['admin_portal:access', 'schedules:read', 'shifts:read', 'locations:read'],
    });

    await expect(SchedulingLayout({ children: 'calendar' })).resolves.toBe('calendar');
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it.each(['schedules:read', 'shifts:read', 'locations:read'])(
    'redirects when %s is missing',
    async (missingPermission) => {
      requireAuthMock.mockResolvedValue({
        permissions: ['schedules:read', 'shifts:read', 'locations:read']
          .filter((permission) => permission !== missingPermission),
      });

      await expect(SchedulingLayout({ children: 'calendar' })).rejects.toThrow('NEXT_REDIRECT');

      expect(redirectMock).toHaveBeenCalledWith('/dashboard');
    },
  );

  it('does not let platform admin access bypass missing tenant read permissions', async () => {
    requireAuthMock.mockResolvedValue({ permissions: ['admin_portal:access'] });

    await expect(SchedulingLayout({ children: 'calendar' })).rejects.toThrow('NEXT_REDIRECT');

    expect(redirectMock).toHaveBeenCalledWith('/dashboard');
  });
});
