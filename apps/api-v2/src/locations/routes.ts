import {
  LocationCreateRequestSchema,
  LocationListQuerySchema,
  LocationListResponseSchema,
  LocationPathSchema,
  LocationRecordSchema,
  LocationRouteProblemResponses,
  LocationSummaryResponseSchema,
  LocationUpdateRequestSchema,
  type LocationCreateRequest,
  type LocationListQuery,
  type LocationListResponse,
  type LocationRecord,
  type LocationSummaryResponse,
  type LocationUpdateRequest,
} from '@lunchlineup/api-contract';
import { Type } from '@sinclair/typebox';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ApiV2Config } from '../config';
import { type IdentityAdapter, requirePermissions } from '../platform/identity';
import { assertUnsafeRequestSecurity } from '../platform/request-security';
import type { LocationService } from './locations.service';

export type LocationRouteDependencies = {
  config: ApiV2Config;
  identity: IdentityAdapter;
  locations: Pick<LocationService, 'list' | 'summary' | 'get' | 'create' | 'update' | 'remove'>;
};

function header(request: FastifyRequest, name: string): string | undefined {
  const value = request.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export async function registerLocationRoutes(
  app: FastifyInstance,
  dependencies: LocationRouteDependencies,
): Promise<void> {
  app.get<{
    Querystring: LocationListQuery;
  }>('/v2/locations', {
    schema: {
      operationId: 'listLocations',
      summary: 'List active locations',
      description: 'Native API-02 location owner. Returned identifiers are tenant-scoped public UUIDs.',
      tags: ['Locations'],
      querystring: LocationListQuerySchema,
      response: { 200: LocationListResponseSchema, ...LocationRouteProblemResponses },
    },
  }, async (request, reply): Promise<LocationListResponse> => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['locations:read']);
    const response = await dependencies.locations.list(identity, request.query);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.post<{
    Body: LocationCreateRequest;
  }>('/v2/locations', {
    schema: {
      operationId: 'createLocation',
      summary: 'Create a location',
      description: 'Creates one tenant location with a stable public UUID and optional durable idempotency replay.',
      tags: ['Locations'],
      body: LocationCreateRequestSchema,
      response: { 201: LocationRecordSchema, ...LocationRouteProblemResponses },
    },
  }, async (request, reply): Promise<LocationRecord> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['locations:write']);
    const response = await dependencies.locations.create(identity, request.body, header(request, 'idempotency-key'));
    reply.code(201).header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get('/v2/locations/summary', {
    schema: {
      operationId: 'getLocationSummary',
      summary: 'Read the location summary',
      description: 'Returns the exact active-location count without materializing location records.',
      tags: ['Locations'],
      response: { 200: LocationSummaryResponseSchema, ...LocationRouteProblemResponses },
    },
  }, async (request, reply): Promise<LocationSummaryResponse> => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['locations:read']);
    const response = await dependencies.locations.summary(identity);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.get<{
    Params: { locationId: string };
  }>('/v2/locations/:locationId', {
    schema: {
      operationId: 'getLocation',
      summary: 'Read one location',
      description: 'Reads one active tenant location by its public UUID.',
      tags: ['Locations'],
      params: LocationPathSchema,
      response: { 200: LocationRecordSchema, ...LocationRouteProblemResponses },
    },
  }, async (request, reply): Promise<LocationRecord> => {
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['locations:read']);
    const response = await dependencies.locations.get(identity, request.params.locationId);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.put<{
    Params: { locationId: string };
    Body: LocationUpdateRequest;
  }>('/v2/locations/:locationId', {
    schema: {
      operationId: 'updateLocation',
      summary: 'Replace one location',
      description: 'Replaces mutable location fields and safely invalidates affected draft schedule revisions.',
      tags: ['Locations'],
      params: LocationPathSchema,
      body: LocationUpdateRequestSchema,
      response: { 200: LocationRecordSchema, ...LocationRouteProblemResponses },
    },
  }, async (request, reply): Promise<LocationRecord> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['locations:write']);
    const response = await dependencies.locations.update(identity, request.params.locationId, request.body);
    reply.header('Cache-Control', 'private, no-store');
    return response;
  });

  app.delete<{
    Params: { locationId: string };
  }>('/v2/locations/:locationId', {
    schema: {
      operationId: 'deleteLocation',
      summary: 'Archive one location',
      description: 'Soft-deletes one tenant location while retaining historical schedules and shifts.',
      tags: ['Locations'],
      params: LocationPathSchema,
      response: { 204: Type.Null(), ...LocationRouteProblemResponses },
    },
  }, async (request, reply): Promise<void> => {
    assertUnsafeRequestSecurity(request, dependencies.config);
    const identity = await dependencies.identity.authenticate(request, reply);
    requirePermissions(identity, ['locations:delete']);
    await dependencies.locations.remove(identity, request.params.locationId);
    reply.code(204).header('Cache-Control', 'private, no-store').send();
  });
}
