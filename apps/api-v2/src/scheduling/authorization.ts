import type { ScheduleChangeSetRequest, SessionIdentity } from '@lunchlineup/api-contract';
import { requirePermissions } from '../platform/identity';

// Shared pure checks run before quota at HTTP dispatch and remain enforced
// inside each domain service. Database-backed authorization is unchanged.
export function authorizeScheduleChangeSet(identity: SessionIdentity, body: ScheduleChangeSetRequest): void {
  if (body.operations.some((operation) => operation.op === 'shift.delete')) {
    requirePermissions(identity, ['shifts:delete']);
  }
  if (body.operations.some((operation) => operation.op !== 'shift.delete')) {
    requirePermissions(identity, ['shifts:write']);
  }
}

export function authorizeScheduleDemand(identity: SessionIdentity): void {
  requirePermissions(identity, ['schedules:write']);
}

export function authorizeScheduleReopen(identity: SessionIdentity): void {
  requirePermissions(identity, ['schedules:publish']);
}
