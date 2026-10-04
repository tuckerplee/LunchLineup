import {
  idempotentRequestAttempt,
  type IdempotentRequestAttempt,
} from '../../../lib/client-api';
import { parseSchedulePublishPreflight, type SchedulePublishAcceptedContract } from './publish-settlement';

export type SchedulePublishPayload = Readonly<{
  scheduleId: string;
  body: Readonly<{ acceptedContract: Readonly<SchedulePublishAcceptedContract> }>;
}>;

export type SchedulePublishAttempt = Readonly<IdempotentRequestAttempt & {
  payload: SchedulePublishPayload;
}>;

/** Retain the exact wire request with its key; a later review cannot rewrite a replay. */
export function schedulePublishAttempt(
  scheduleId: string,
  acceptedContract: SchedulePublishAcceptedContract,
  current?: IdempotentRequestAttempt | null,
  keyFactory?: () => string,
): SchedulePublishAttempt {
  const payload = Object.freeze({
    scheduleId,
    body: Object.freeze({ acceptedContract: Object.freeze({ ...acceptedContract }) }),
  });
  const identity = keyFactory
    ? idempotentRequestAttempt(payload, current, keyFactory)
    : idempotentRequestAttempt(payload, current);
  const saved = readSchedulePublishAttempt(scheduleId, current);
  if (saved && saved.payloadFingerprint === identity.payloadFingerprint && saved.key === identity.key) return saved;
  return Object.freeze({ ...identity, payload });
}

/** A damaged retry record must never be reconstructed from a different shared review. */
export function readSchedulePublishAttempt(scheduleId: string, value: unknown): SchedulePublishAttempt | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const attempt = value as SchedulePublishAttempt;
  if (typeof attempt.key !== 'string' || !attempt.key.trim()
    || typeof attempt.payloadFingerprint !== 'string'
    || !attempt.payload || attempt.payload.scheduleId !== scheduleId
    || !attempt.payload.body || !attempt.payload.body.acceptedContract) return null;
  try {
    const contract = attempt.payload.body.acceptedContract;
    parseSchedulePublishPreflight(scheduleId, {
      scheduleId, ...contract, acceptedContract: contract,
      availableCredits: contract.totalConfiguredCost, sufficientCredits: true,
    });
    const canonical = idempotentRequestAttempt(attempt.payload, attempt, () => attempt.key);
    if (canonical.payloadFingerprint !== attempt.payloadFingerprint) return null;
    if (!Object.isFrozen(attempt) || !Object.isFrozen(attempt.payload)
      || !Object.isFrozen(attempt.payload.body) || !Object.isFrozen(contract)) return null;
    return attempt;
  } catch {
    return null;
  }
}
