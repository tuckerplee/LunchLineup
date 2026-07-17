import {
  idempotentRequestAttempt,
  type IdempotentRequestAttempt,
} from '../../../lib/client-api';
import type { SchedulePublishAcceptedContract } from './publish-settlement';

export type SchedulePublishPayload = {
  scheduleId: string;
  body: { acceptedContract: SchedulePublishAcceptedContract };
};

export function schedulePublishAttempt(
  scheduleId: string,
  acceptedContract: SchedulePublishAcceptedContract,
  current?: IdempotentRequestAttempt | null,
  keyFactory?: () => string,
): IdempotentRequestAttempt {
  const payload: SchedulePublishPayload = {
    scheduleId,
    body: { acceptedContract },
  };
  return keyFactory
    ? idempotentRequestAttempt(payload, current, keyFactory)
    : idempotentRequestAttempt(payload, current);
}
