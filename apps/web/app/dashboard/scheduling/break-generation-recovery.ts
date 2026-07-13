import { idempotentRequestAttempt, type IdempotentRequestAttempt } from '@/lib/client-api';

export type BreakGenerationResponse = { locationId?: string; data?: Array<{ shiftId?: string }> };
export type BreakGenerationAttempt =
  | (IdempotentRequestAttempt & { postConfirmed: false; response?: never })
  | (IdempotentRequestAttempt & { postConfirmed: true; response: BreakGenerationResponse });

export async function executeBreakGenerationWithRecovery<T>({
  requestBody,
  currentAttempt,
  retainAttempt,
  postGeneration,
  reconcile,
  keyFactory,
}: {
  requestBody: unknown;
  currentAttempt: BreakGenerationAttempt | null;
  retainAttempt: (attempt: BreakGenerationAttempt | null) => void;
  postGeneration: (key: string) => Promise<BreakGenerationResponse>;
  reconcile: (response: BreakGenerationResponse) => Promise<T>;
  keyFactory?: () => string;
}): Promise<T> {
  const payloadAttempt = idempotentRequestAttempt(requestBody, currentAttempt, keyFactory);
  let attempt: BreakGenerationAttempt = currentAttempt && payloadAttempt === currentAttempt
    ? currentAttempt
    : { ...payloadAttempt, postConfirmed: false };
  retainAttempt(attempt);

  if (!attempt.postConfirmed) {
    const response = await postGeneration(attempt.key);
    attempt = { ...attempt, postConfirmed: true, response };
    retainAttempt(attempt);
  }

  const reconciled = await reconcile(attempt.response);
  retainAttempt(null);
  return reconciled;
}
