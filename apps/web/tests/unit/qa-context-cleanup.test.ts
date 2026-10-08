import type { BrowserContext, Page } from '@playwright/test';
import { describe, expect, it, vi } from 'vitest';
import { closeQaContexts } from '../e2e/qa-context-cleanup';

function deferred() {
  let resolve!: () => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function page(wait: () => Promise<void>, closed = false) {
  const waitForLoadState = vi.fn(wait);
  return { value: { isClosed: () => closed, waitForLoadState } as unknown as Page, waitForLoadState };
}

function context(pages: Page[], close: () => Promise<void> = vi.fn(async () => undefined)) {
  return { value: { pages: () => pages, close } as unknown as BrowserContext, close };
}

async function failureOf(promise: Promise<void>) {
  try { await promise; } catch (error) { return error as AggregateError; }
  throw new Error('Cleanup unexpectedly succeeded');
}

describe('owned QA context cleanup', () => {
  it('settles every open document before guarded closure, without requiring polling to stop', async () => {
    const first = deferred(), second = deferred();
    const a = page(() => first.promise), b = page(() => second.promise);
    const owner = context([a.value, b.value]);
    const pending = closeQaContexts([owner.value]);
    expect(a.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 5_000 });
    expect(b.waitForLoadState).toHaveBeenCalledWith('domcontentloaded', { timeout: 5_000 });
    expect(owner.close).not.toHaveBeenCalled();
    first.resolve();
    await Promise.resolve();
    expect(owner.close).not.toHaveBeenCalled();
    second.resolve();
    await pending;
    expect(owner.close).toHaveBeenCalledOnce();
  });

  it('closes API-only contexts and skips pages that are already closed', async () => {
    const closed = page(async () => { throw new Error('Closed page must not be waited on'); }, true);
    const api = context([]), owner = context([closed.value]);
    await closeQaContexts([api.value, owner.value]);
    expect(closed.waitForLoadState).not.toHaveBeenCalled();
    expect(api.close).toHaveBeenCalledOnce();
    expect(owner.close).toHaveBeenCalledOnce();
  });

  it('retains timeout, close and primary failures while attempting every owned context', async () => {
    const timeout = new Error('Native document settling timed out'), closing = new Error('Guard drain failed');
    const primary = new Error('Rendered state assertion failed');
    const failed = context([page(async () => { throw timeout; }).value], vi.fn(async () => { throw closing; }));
    const healthy = context([]);
    const error = await failureOf(closeQaContexts([failed.value, healthy.value], primary));
    expect(error.errors[0]).toBe(primary);
    expect((error.errors[1] as AggregateError).errors).toEqual([timeout, closing]);
    expect(failed.close).toHaveBeenCalledOnce();
    expect(healthy.close).toHaveBeenCalledOnce();
  });

  it('settles all contexts independently and waits for their closure before rejecting', async () => {
    const slow = deferred(), denied = new Error('Isolation guard rejected closure');
    const failed = context([], vi.fn(async () => { throw denied; }));
    const healthy = context([], vi.fn(() => slow.promise));
    let settled = false;
    const pending = failureOf(closeQaContexts([failed.value, healthy.value])).then(error => {
      settled = true;
      return error;
    });
    await Promise.resolve();
    await Promise.resolve();
    expect(healthy.close).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    slow.resolve();
    const error = await pending;
    expect((error.errors[0] as AggregateError).errors).toEqual([denied]);
  });

  it('still closes an owner if page enumeration fails', async () => {
    const enumeration = new Error('Context pages could not be read');
    const owner = context([]);
    const broken = { pages: () => { throw enumeration; }, close: owner.close } as unknown as BrowserContext;
    const error = await failureOf(closeQaContexts([broken]));
    expect(owner.close).toHaveBeenCalledOnce();
    expect((error.errors[0] as AggregateError).errors).toEqual([enumeration]);
  });

  it('does not replace a primary failure when cleanup succeeds', async () => {
    const primary = new Error('Original failure is rethrown by the caller');
    const owner = context([]);
    await closeQaContexts([owner.value], primary);
    expect(owner.close).toHaveBeenCalledOnce();
  });
});
