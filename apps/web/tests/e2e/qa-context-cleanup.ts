import type { BrowserContext } from '@playwright/test';

// Settle the current document before guarded closure drains owned routes.
// Polling need not become idle; rendered-state assertions belong to the test.
export async function closeQaContexts(contexts: BrowserContext[], primaryFailure?: unknown): Promise<void> {
  const closed = await Promise.allSettled(contexts.map(async context => {
    const failures: unknown[] = [];
    try {
      const documents = await Promise.allSettled(context.pages().filter(page => !page.isClosed())
        .map(page => page.waitForLoadState('domcontentloaded', { timeout: 5_000 })));
      failures.push(...documents.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason));
    } catch (error) { failures.push(error); }
    // Always attempt owned closure, including after a document timeout. Keep the
    // existing guard and its denial, route-drain and close failure checks.
    try { await context.close(); } catch (error) { failures.push(error); }
    if (failures.length) throw new AggregateError(failures, 'Owned QA page settling or context closure failed.');
  }));
  const failures = closed.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
    .map(result => result.reason);
  if (failures.length) throw new AggregateError(
    primaryFailure === undefined ? failures : [primaryFailure, ...failures],
    'Native context cleanup failed; primary failure retained when present',
  );
}
