import type { ApplicationApiOperation } from '@lunchlineup/api-contract';
import { describe, expect, it, vi } from 'vitest';
import { LocationIdentifierTranslator } from './identifier-translation';

const publicLocationId = '34aa4812-63f5-4e5c-8b3a-06b564987a1f';
const internalLocationId = 'location-storage-1';

const operation: ApplicationApiOperation = {
  operationId: 'clockIn',
  method: 'POST',
  path: '/time-cards/clock-in',
  tag: 'Time',
  summary: 'Create a clock-in event',
};

function translator() {
  const resolver = {
    resolvePublicIds: vi.fn(async () => new Map([[publicLocationId, internalLocationId]])),
    resolveInternalIds: vi.fn(async () => new Map([[internalLocationId, publicLocationId]])),
  };
  return { instance: new LocationIdentifierTranslator(resolver), resolver };
}

describe('location identifier compatibility translation', () => {
  it('converts only declared location references before a retained call', async () => {
    const { instance, resolver } = translator();
    const request = await instance.translateRequest(
      operation,
      'tenant-1',
      `http://api:3000/v1/time-cards/clock-in?locationId=${publicLocationId}`,
      JSON.stringify({ locationId: publicLocationId, nested: { locationIds: [publicLocationId] }, id: publicLocationId }),
      { locationId: publicLocationId, nested: { locationIds: [publicLocationId] }, id: publicLocationId },
    );

    expect(request.target).toContain(`locationId=${internalLocationId}`);
    expect(JSON.parse(String(request.body))).toEqual({
      locationId: internalLocationId,
      nested: { locationIds: [internalLocationId] },
      id: publicLocationId,
    });
    expect(resolver.resolvePublicIds).toHaveBeenCalledWith('tenant-1', [publicLocationId]);
  });

  it('converts retained response references back to public UUIDs and fails closed for unknown rows', async () => {
    const { instance } = translator();
    await expect(instance.translateResponse(operation, 'tenant-1', {
      data: [{ locationId: internalLocationId }],
      id: internalLocationId,
    })).resolves.toEqual({
      data: [{ locationId: publicLocationId }],
      id: internalLocationId,
    });

    const unavailable = new LocationIdentifierTranslator({
      resolvePublicIds: async () => new Map(),
      resolveInternalIds: async () => new Map(),
    });
    await expect(unavailable.translateResponse(operation, 'tenant-1', { locationId: internalLocationId }))
      .rejects.toMatchObject({ status: 502, code: 'invalid_compatibility_response' });
  });

  it('does not attach a translator to unrelated retained domains', async () => {
    const { instance, resolver } = translator();
    const billingOperation: ApplicationApiOperation = {
      operationId: 'getBillingFeatures',
      method: 'GET',
      path: '/billing/features',
      tag: 'Billing',
      summary: 'Read billing features and entitlements',
    };
    await expect(instance.translateResponse(billingOperation, 'tenant-1', { locationId: internalLocationId }))
      .resolves.toEqual({ locationId: internalLocationId });
    expect(resolver.resolveInternalIds).not.toHaveBeenCalled();
  });
});
