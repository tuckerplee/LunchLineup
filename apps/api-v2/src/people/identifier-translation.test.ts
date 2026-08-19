import type { ApplicationApiOperation } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { PeopleIdentifierTranslator } from './identifier-translation';

const publicUserId = 'f6776d21-bb21-4c35-a6ed-5da8df5ed238';
const internalUserId = 'user-storage-1';

const operation: ApplicationApiOperation = {
  operationId: 'deleteStaffMember',
  method: 'DELETE',
  path: '/users/:userId',
  tag: 'People',
  summary: 'Deactivate a staff member',
};

function translator() {
  const resolver = {
    resolvePublicUserIds: vi.fn(async () => new Map([[publicUserId, internalUserId]])),
    resolveInternalUserIds: vi.fn(async () => new Map([[internalUserId, publicUserId]])),
  };
  return { instance: new PeopleIdentifierTranslator(resolver), resolver };
}

describe('people identifier compatibility translation', () => {
  it('rewrites only explicit public user references, including a retained path parameter', async () => {
    const { instance, resolver } = translator();
    const body = {
      userId: publicUserId,
      nested: { userIds: [publicUserId], id: publicUserId },
      id: publicUserId,
    };
    const translated = await instance.translateRequest(
      operation,
      'tenant-1',
      `http://api:3000/v1/users/${publicUserId}?userId=${publicUserId}`,
      JSON.stringify(body),
      body,
    );

    expect(translated.target).toBe(`http://api:3000/v1/users/${internalUserId}?userId=${internalUserId}`);
    expect(JSON.parse(String(translated.body))).toEqual({
      userId: internalUserId,
      nested: { userIds: [internalUserId], id: publicUserId },
      id: publicUserId,
    });
    expect(resolver.resolvePublicUserIds).toHaveBeenCalledWith('tenant-1', [publicUserId]);
  });

  it('returns public user UUIDs from retained responses and fails closed for unknown storage keys', async () => {
    const { instance } = translator();
    await expect(instance.translateResponse(operation, 'tenant-1', {
      userId: internalUserId,
      nested: { userIds: [internalUserId], id: internalUserId },
      id: internalUserId,
    })).resolves.toEqual({
      userId: publicUserId,
      nested: { userIds: [publicUserId], id: internalUserId },
      id: internalUserId,
    });

    const unavailable = new PeopleIdentifierTranslator({
      resolvePublicUserIds: async () => new Map(),
      resolveInternalUserIds: async () => new Map(),
    });
    await expect(unavailable.translateResponse(operation, 'tenant-1', { userId: internalUserId }))
      .rejects.toMatchObject({ status: 502, code: 'invalid_compatibility_response' });
    await expect(unavailable.translateRequest(
      operation,
      'tenant-1',
      'http://api:3000/v1/users/not-a-public-uuid',
      undefined,
      undefined,
    )).rejects.toMatchObject({ status: 404, code: 'staff_not_found' });
  });

  it('does not translate user fields for a domain that has not opted into the bridge seam', async () => {
    const { instance, resolver } = translator();
    const administration: ApplicationApiOperation = {
      operationId: 'getTenantAdministration',
      method: 'GET',
      path: '/admin/tenants/:tenantId',
      tag: 'Administration',
      summary: 'Read tenant administration',
    };
    await expect(instance.translateResponse(administration, 'tenant-1', { userId: internalUserId }))
      .resolves.toEqual({ userId: internalUserId });
    expect(resolver.resolveInternalUserIds).not.toHaveBeenCalled();
  });
});
