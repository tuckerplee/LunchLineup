import { Value } from '@sinclair/typebox/value';
import { describe, expect, it } from 'vitest';
import {
  LocationCreateRequestSchema,
  LocationListResponseSchema,
  LocationUpdateRequestSchema,
} from './locations';

describe('API v2 location contract', () => {
  it('accepts a bounded public location record and opaque-list envelope', () => {
    expect(Value.Check(LocationListResponseSchema, {
      data: [{
        id: '34aa4812-63f5-4e5c-8b3a-06b564987a1f',
        name: 'Downtown Diner',
        address: null,
        timezone: 'America/Los_Angeles',
        createdAt: '2026-07-18T00:00:00.000Z',
        updatedAt: '2026-07-18T00:00:00.000Z',
      }],
      pagination: {
        limit: 100,
        maxLimit: 200,
        returned: 1,
        hasMore: false,
        nextCursor: null,
      },
    })).toBe(true);
  });

  it('requires a timezone and refuses undeclared location-write fields', () => {
    expect(Value.Check(LocationCreateRequestSchema, {
      name: 'Downtown Diner',
      timezone: 'America/Los_Angeles',
    })).toBe(true);
    expect(Value.Check(LocationCreateRequestSchema, { name: 'Downtown Diner' })).toBe(false);
    expect(Value.Check(LocationUpdateRequestSchema, {
      name: 'Downtown Diner',
      timezone: 'America/Los_Angeles',
      tenantId: 'another-tenant',
    })).toBe(false);
  });
});
