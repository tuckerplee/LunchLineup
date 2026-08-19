import type { SessionIdentity } from '@lunchlineup/api-contract';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { ProblemError } from './problem';

/**
 * The application and scheduling modules depend on this narrow session
 * boundary, never on a particular generation of the auth implementation.
 */
export type IdentityAdapter = {
  authenticate(request: FastifyRequest, reply: FastifyReply): Promise<SessionIdentity>;
  ready?(): Promise<void>;
  close?(): Promise<void>;
};

export function requirePermissions(identity: SessionIdentity, permissions: readonly string[]): void {
  const missing = permissions.filter((permission) => !identity.permissions.includes(permission));
  if (missing.length > 0) {
    throw new ProblemError(
      403,
      'permission_denied',
      'You do not have permission to perform this action.',
      'Forbidden',
    );
  }
}

export function requireAnyPermission(identity: SessionIdentity, permissions: readonly string[]): void {
  if (!permissions.some((permission) => identity.permissions.includes(permission))) {
    throw new ProblemError(
      403,
      'permission_denied',
      'You do not have permission to perform this action.',
      'Forbidden',
    );
  }
}
