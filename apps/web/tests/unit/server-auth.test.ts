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
    'x-lunchlineup-user-public-id': 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
    'x-lunchlineup-user-role': 'ADMIN',
    'x-lunchlineup-workspace-scope': 'A'.repeat(43),
    'x-lunchlineup-session-scope': 'B'.repeat(43),
    'x-lunchlineup-user-permissions': 'dashboard:access,users:read',
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
      publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238',
      role: 'ADMIN',
      workspaceScope: 'A'.repeat(43),
      sessionScope: 'B'.repeat(43),
      permissions: ['dashboard:access', 'users:read'],
    });
  });

  it.each([
    ['unknown role', { 'x-lunchlineup-user-role': 'OWNER' }],
    ['RBAC display role instead of canonical role', { 'x-lunchlineup-user-role': 'Admin' }],
    ['case-confusable role', { 'x-lunchlineup-user-role': 'STAFF\u00c9' }],
    ['invalid opaque workspace scope', { 'x-lunchlineup-workspace-scope': 'tenant one' }],
    ['invalid public user id', { 'x-lunchlineup-user-public-id': 'not-a-uuid' }],
    ['oversized permission list', { 'x-lunchlineup-user-permissions': Array.from({ length: 201 }, (_, i) => `p:${i}`).join(',') }],
  ])('rejects %s instead of trusting malformed forwarded identity', async (_label, overrides) => {
    setIdentityHeaders(overrides);
    await expect(getServerUser()).resolves.toBeNull();
  });
});
