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

  it('releases the body lock after exact-limit multichunk EOF without cancellation', async () => {
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([0, 255]));
        controller.enqueue(new Uint8Array([128, 1]));
        controller.close();
      },
      cancel() { canceled += 1; },
    });
    await expect(readBoundedResponseBytes(new Response(body), 4)).resolves.toEqual(new Uint8Array([0, 255, 128, 1]));
    expect(body.locked).toBe(false);
    expect(canceled).toBe(0);
  });

  it.each([false, true])('cancels overflow and releases the lock when cancellation rejects: %s', async (cancelRejects) => {
    const cancellationFailure = new Error('cancellation failed');
    let canceled = 0;
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array([1, 2, 3]));
        controller.enqueue(new Uint8Array([4, 5]));
      },
      cancel() {
        canceled += 1;
        if (cancelRejects) return Promise.reject(cancellationFailure);
      },
    });
    await expect(readBoundedResponseBytes(new Response(body), 4)).rejects.toBeInstanceOf(ResponseBodyLimitError);
    expect(canceled).toBe(1);
    expect(body.locked).toBe(false);
  });

  it.each([
    new Error('body read failed'),
    new DOMException('body aborted', 'AbortError'),
  ])('preserves the exact read rejection and releases the body lock: %s', async (failure) => {
    let pulls = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (pulls++ === 0) controller.enqueue(new Uint8Array([1, 2]));
        else controller.error(failure);
      },
    });
    await expect(readBoundedResponseBytes(new Response(body), 4)).rejects.toBe(failure);
    expect(body.locked).toBe(false);
  });
});
