export const DEFAULT_JSON_RESPONSE_LIMIT_BYTES = 1024 * 1024;

export class ResponseBodyLimitError extends Error {
  constructor() {
    super('Response body exceeded the configured limit.');
    this.name = 'ResponseBodyLimitError';
  }
}

export class RequestTimeoutError extends Error {
  constructor() {
    super('Request timed out.');
    this.name = 'TimeoutError';
  }
}

export async function withRequestTimeout<T>(
  operation: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  externalSignal?: AbortSignal | null,
): Promise<T> {
  const controller = new AbortController();
  let timedOut = false;
  const forwardAbort = () => controller.abort(externalSignal?.reason);
  if (externalSignal?.aborted) forwardAbort();
  else externalSignal?.addEventListener('abort', forwardAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const result = await operation(controller.signal);
    if (timedOut) throw new RequestTimeoutError();
    if (externalSignal?.aborted) {
      throw externalSignal.reason instanceof Error
        ? externalSignal.reason
        : new DOMException('Request canceled.', 'AbortError');
    }
    return result;
  } catch (error) {
    if (timedOut) throw new RequestTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', forwardAbort);
  }
}

export async function readBoundedResponseBytes(
  response: Response,
  maxBytes = DEFAULT_JSON_RESPONSE_LIMIT_BYTES,
): Promise<Uint8Array> {
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new ResponseBodyLimitError();
  }
  if (!response.body) return new Uint8Array();

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) throw new ResponseBodyLimitError();
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

export async function readBoundedJson(
  response: Response,
  maxBytes = DEFAULT_JSON_RESPONSE_LIMIT_BYTES,
): Promise<unknown> {
  const bytes = await readBoundedResponseBytes(response, maxBytes);
  if (bytes.byteLength === 0) return null;
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
