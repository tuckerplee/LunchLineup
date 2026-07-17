import { describe, expect, it } from 'vitest';

import {
  ResponseBodyLimitError,
  readBoundedJson,
  readBoundedResponseBytes,
  withRequestTimeout,
} from '../../lib/http-safety';

describe('bounded HTTP safety primitives', () => {
  it('aborts an operation at its deadline with a stable timeout classification', async () => {
    const pending = withRequestTimeout(
      (signal) => new Promise<never>((_resolve, reject) => {
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true });
      }),
      5,
    );

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError', message: 'Request timed out.' });
  });

  it('keeps the deadline authoritative when an inner operation swallows its abort', async () => {
    const pending = withRequestTimeout(
      (signal) => new Promise<string>((resolve) => {
        signal.addEventListener('abort', () => resolve('late result'), { once: true });
      }),
      5,
    );

    await expect(pending).rejects.toMatchObject({ name: 'TimeoutError' });
  });
  it('rejects declared and streamed bodies above the byte ceiling', async () => {
    const declared = new Response('12345', { headers: { 'content-length': '5' } });
    await expect(readBoundedResponseBytes(declared, 4)).rejects.toBeInstanceOf(ResponseBodyLimitError);

    const streamed = new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('123'));
        controller.enqueue(new TextEncoder().encode('45'));
        controller.close();
      },
    }));
    await expect(readBoundedResponseBytes(streamed, 4)).rejects.toBeInstanceOf(ResponseBodyLimitError);
  });

  it('parses JSON only after the complete body fits within the limit', async () => {
    await expect(readBoundedJson(new Response('{"ok":true}'), 32)).resolves.toEqual({ ok: true });
  });
});
