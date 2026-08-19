import type { ApplicationApiOperation } from '@lunchlineup/api-contract';
import { ProblemError } from '../platform/problem';
import type { PeopleService } from './people.service';

const MAX_REFERENCE_NODES = 10_000;
const MAX_REFERENCE_DEPTH = 32;
const PUBLIC_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Native People callers use `User.publicId`. This seam keeps the remaining
 * retained domains from accepting or leaking private user storage keys while
 * touching only declared `userId` and `userIds` fields (never generic `id`).
 */
const USER_REFERENCE_TAGS = new Set<ApplicationApiOperation['tag']>([
  'People',
  'Time',
  'Payroll',
  'Notifications',
  'Imports',
]);

type UserIdentifierResolver = Pick<PeopleService, 'resolvePublicUserIds' | 'resolveInternalUserIds'>;
type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value) && !Buffer.isBuffer(value);
}

function applies(operation: ApplicationApiOperation): boolean {
  return USER_REFERENCE_TAGS.has(operation.tag);
}

function references(value: unknown): string[] {
  const output = new Set<string>();
  let visited = 0;
  const visit = (candidate: unknown, depth: number): void => {
    visited += 1;
    if (visited > MAX_REFERENCE_NODES || depth > MAX_REFERENCE_DEPTH) throw new Error('User reference payload exceeds bounded traversal limits.');
    if (Array.isArray(candidate)) {
      for (const row of candidate) visit(row, depth + 1);
      return;
    }
    if (!isRecord(candidate)) return;
    for (const [key, child] of Object.entries(candidate)) {
      if (key === 'userId' && typeof child === 'string') output.add(child);
      if (key === 'userIds' && Array.isArray(child)) {
        for (const item of child) if (typeof item === 'string') output.add(item);
      }
      visit(child, depth + 1);
    }
  };
  visit(value, 0);
  return [...output];
}

function replaceReferences(value: unknown, mapping: ReadonlyMap<string, string>): unknown {
  if (Array.isArray(value)) return value.map((item) => replaceReferences(item, mapping));
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.entries(value).map(([key, child]) => {
    if (key === 'userId' && typeof child === 'string') return [key, mapping.get(child) ?? child];
    if (key === 'userIds' && Array.isArray(child)) {
      return [key, child.map((item) => typeof item === 'string' ? mapping.get(item) ?? item : item)];
    }
    return [key, replaceReferences(child, mapping)];
  }));
}

function requestProblem(): ProblemError {
  return new ProblemError(404, 'staff_not_found', 'A requested staff member was not found in this workspace.', 'Staff member not found');
}

function responseProblem(): ProblemError {
  return new ProblemError(
    502,
    'invalid_compatibility_response',
    'A retained application subsystem returned an invalid staff reference.',
    'Bad gateway',
  );
}

function pathUserId(operation: ApplicationApiOperation, target: URL): string | null {
  if (!operation.path.includes(':userId')) return null;
  const template = operation.path.split('/').filter(Boolean);
  const actual = target.pathname.replace(/^\/v1\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  const index = template.indexOf(':userId');
  return index >= 0 ? actual[index] ?? null : null;
}

function replacePathUserId(operation: ApplicationApiOperation, target: URL, mapping: ReadonlyMap<string, string>): void {
  const publicId = pathUserId(operation, target);
  if (!publicId) return;
  const internalId = mapping.get(publicId);
  if (!internalId) return;
  const segments = target.pathname.split('/');
  const template = operation.path.split('/').filter(Boolean);
  const position = template.indexOf(':userId');
  // `/v1` takes the first path segment; preserve path encoding for opaque IDs.
  segments[position + 2] = encodeURIComponent(internalId);
  target.pathname = segments.join('/');
}

export class PeopleIdentifierTranslator {
  constructor(private readonly resolver: UserIdentifierResolver) {}

  async translateRequest(
    operation: ApplicationApiOperation,
    tenantId: string,
    target: string,
    body: string | Buffer | undefined,
    parsedBody: unknown,
  ): Promise<{ target: string; body: string | Buffer | undefined }> {
    if (!applies(operation)) return { target, body };
    const url = new URL(target);
    const pathReference = pathUserId(operation, url);
    const queryReferences = url.searchParams.getAll('userId');
    let bodyReferences: string[];
    try {
      bodyReferences = parsedBody === undefined || typeof parsedBody === 'string' || Buffer.isBuffer(parsedBody)
        ? []
        : references(parsedBody);
    } catch {
      throw new ProblemError(422, 'invalid_staff_reference', 'Staff references exceed supported request limits.', 'Staff validation failed');
    }
    const publicIds = [...new Set([
      ...(pathReference ? [pathReference] : []),
      ...queryReferences,
      ...bodyReferences,
    ])];
    if (publicIds.length === 0) return { target, body };
    if (publicIds.some((value) => !PUBLIC_UUID.test(value))) throw requestProblem();
    const internalByPublicId = await this.resolver.resolvePublicUserIds(tenantId, publicIds);
    if (publicIds.some((value) => !internalByPublicId.has(value))) throw requestProblem();
    replacePathUserId(operation, url, internalByPublicId);
    if (queryReferences.length > 0) {
      url.searchParams.delete('userId');
      for (const value of queryReferences) url.searchParams.append('userId', internalByPublicId.get(value) ?? value);
    }
    return {
      target: url.toString(),
      body: parsedBody === undefined || typeof parsedBody === 'string' || Buffer.isBuffer(parsedBody)
        ? body
        : JSON.stringify(replaceReferences(parsedBody, internalByPublicId)),
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
      internalIds = references(payload);
    } catch {
      throw responseProblem();
    }
    if (internalIds.length === 0) return payload;
    const publicByInternalId = await this.resolver.resolveInternalUserIds(tenantId, internalIds);
    if (internalIds.some((value) => !publicByInternalId.has(value))) throw responseProblem();
    return replaceReferences(payload, publicByInternalId);
  }
}
