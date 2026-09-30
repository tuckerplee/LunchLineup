import type { BrowserContext } from '@playwright/test';

// Finish the owned page's real requests before its isolation guard closes
// admission. This is cleanup, not a substitute for rendered-state assertions.
export async function closeQaContexts(contexts: BrowserContext[], primaryFailure?: unknown): Promise<void> {
  const closed = await Promise.allSettled(contexts.map(async context => {
    const failures: unknown[] = [];
    try {
      const idle = await Promise.allSettled(context.pages().filter(page => !page.isClosed())
        .map(page => page.waitForLoadState('networkidle', { timeout: 5_000 })));
      failures.push(...idle.filter((result): result is PromiseRejectedResult => result.status === 'rejected')
        .map(result => result.reason));
    } catch (error) { failures.push(error); }
    // Always attempt owned closure, including after an idle timeout. Keep the
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
