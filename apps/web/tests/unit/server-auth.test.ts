import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  headers: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock('next/headers', () => ({ headers: mocks.headers }));
vi.mock('next/navigation', () => ({ redirect: mocks.redirect }));

import { getServerUser } from '../../lib/server-auth';

function setIdentityHeaders(overrides: Record<string, string> = {}) {
  mocks.headers.mockResolvedValue(new Headers({
    'x-user-id': 'user-1',
    'x-user-public-id': 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
    'x-user-role': 'ADMIN',
    'x-tenant-id': 'tenant-1',
    'x-user-permissions': 'dashboard:access,users:read',
    'x-user-roles': 'Admin,Manager',
    ...overrides,
  }));
}

afterEach(() => {
  mocks.headers.mockReset();
  mocks.redirect.mockReset();
});

describe('server auth identity headers', () => {
  it('accepts the bounded identity contract injected by the proxy', async () => {
    setIdentityHeaders();

    await expect(getServerUser()).resolves.toEqual({
      id: 'user-1',
      publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
      role: 'ADMIN',
      tenantId: 'tenant-1',
      permissions: ['dashboard:access', 'users:read'],
      roles: [
        { id: 'Admin', name: 'Admin' },
        { id: 'Manager', name: 'Manager' },
      ],
    });
  });

  it.each([
    ['unknown role', { 'x-user-role': 'OWNER' }],
    ['RBAC display role instead of canonical role', { 'x-user-role': 'Admin' }],
    ['case-confusable role', { 'x-user-role': 'STAFF\u00c9' }],
    ['invalid tenant token', { 'x-tenant-id': 'tenant one' }],
    ['invalid public user id', { 'x-user-public-id': 'not-a-uuid' }],
    ['oversized permission list', { 'x-user-permissions': Array.from({ length: 201 }, (_, i) => `p:${i}`).join(',') }],
  ])('rejects %s instead of trusting malformed forwarded identity', async (_label, overrides) => {
    setIdentityHeaders(overrides);
    await expect(getServerUser()).resolves.toBeNull();
  });
});
