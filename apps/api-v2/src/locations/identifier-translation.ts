import type { ApplicationApiOperation } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';
import type { LocationService } from './locations.service';

const MAX_REFERENCE_NODES = 10_000;
const MAX_REFERENCE_DEPTH = 32;
const PUBLIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Only these retained browser domains are allowed to carry a location
 * reference. The translator itself only touches exact `locationId` and
 * `locationIds` JSON/query fields; it never guesses from arbitrary `id`s.
 */
const LOCATION_REFERENCE_TAGS = new Set<ApplicationApiOperation['tag']>([
  'People',
  'Operations',
  'Time',
  'Payroll',
  'Notifications',
  'Imports',
]);

type LocationIdentifierResolver = Pick<LocationService, 'resolvePublicIds' | 'resolveInternalIds'>;

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function applies(operation: ApplicationApiOperation): boolean {
  return LOCATION_REFERENCE_TAGS.has(operation.tag);
}

function referenceValues(value: unknown): string[] {
  const values = new Set<string>();
  let visited = 0;
  const visit = (candidate: unknown, depth: number): void => {
    visited += 1;
    if (visited > MAX_REFERENCE_NODES || depth > MAX_REFERENCE_DEPTH) {
      throw new Error('Location reference payload exceeds bounded traversal limits.');
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (key === 'locationId' && typeof child === 'string') values.add(child);
      if (key === 'locationIds' && Array.isArray(child)) {
        for (const item of child) if (typeof item === 'string') values.add(item);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return [...values];
}

function replaceReferenceValues(value: unknown, identifiers: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceReferenceValues(item, identifiers));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'locationId' && typeof child === 'string') return [key, identifiers.get(child) ?? child];
    if (key === 'locationIds' && Array.isArray(child)) {
      return [key, child.map((item) => typeof item === 'string' ? identifiers.get(item) ?? item : item)];
    }
    return [key, replaceReferenceValues(child, identifiers)];
  }));
}

function invalidReference(): ProblemError {
  return new ProblemError(
    404,
    'location_not_found',
    'A requested location was not found in this workspace.',
    'Location not found',
  );
}

function invalidCompatibilityResponse(): ProblemError {
  return new ProblemError(
    502,
    'invalid_compatibility_response',
    'A retained application subsystem returned an invalid location reference.',
    'Bad gateway',
  );
}

/**
 * Anti-corruption translator for the temporary API-02 location seam. Native
 * v2 callers use public UUIDs; retained v1 implementations only receive and
 * emit their private storage IDs inside this server process.
 */
export class LocationIdentifierTranslator {
  constructor(private readonly resolver: LocationIdentifierResolver) {}

  async translateRequest(
    operation: ApplicationApiOperation,
    tenantId: string,
    target: string,
    body: string | Buffer | undefined,
    parsedBody: unknown,
  ): Promise<{ target: string; body: string | Buffer | undefined }> {
    if (!applies(operation)) return { target, body };
    const url = new URL(target);
    const queryReferences = url.searchParams.getAll('locationId');
    let bodyReferences: string[];
    try {
      bodyReferences = parsedBody === undefined || typeof parsedBody === 'string' || Buffer.isBuffer(parsedBody)
        ? []
        : referenceValues(parsedBody);
    } catch {
      throw new ProblemError(
        422,
        'invalid_location_reference',
        'Location references exceed supported request limits.',
        'Location validation failed',
      );
    }
    const publicIds = [...new Set([...queryReferences, ...bodyReferences])];
    if (publicIds.length === 0) return { target, body };
    if (publicIds.some((value) => !PUBLIC_UUID.test(value))) throw invalidReference();
    const internalByPublicId = await this.resolver.resolvePublicIds(tenantId, publicIds);
    if (publicIds.some((value) => !internalByPublicId.has(value))) throw invalidReference();

    if (queryReferences.length > 0) {
      url.searchParams.delete('locationId');
      for (const value of queryReferences) url.searchParams.append('locationId', internalByPublicId.get(value) ?? value);
    }
    return {
      target: url.toString(),
      body: parsedBody === undefined || typeof parsedBody === 'string' || Buffer.isBuffer(parsedBody)
        ? body
        : JSON.stringify(replaceReferenceValues(parsedBody, internalByPublicId)),
    };
  }

  async translateResponse(
    operation: ApplicationApiOperation,
    tenantId: string,
    payload: unknown,
  ): Promise<unknown> {
    if (!applies(operation)) return payload;
    let internalIds: string[];
    try {
      internalIds = referenceValues(payload);
    } catch {
      throw invalidCompatibilityResponse();
    }
    if (internalIds.length === 0) return payload;
    const publicByInternalId = await this.resolver.resolveInternalIds(tenantId, internalIds);
    if (internalIds.some((value) => !publicByInternalId.has(value))) throw invalidCompatibilityResponse();
    return replaceReferenceValues(payload, publicByInternalId);
  }
}
