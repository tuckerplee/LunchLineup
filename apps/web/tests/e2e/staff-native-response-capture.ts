// Native original-response observation only. No replay, synthetic response or assertion weakening.
import type { APIResponse, Page, Request, Response, Route } from '@playwright/test';
import { expect } from './qa-isolation-fixture';
import { QA_ORIGIN } from './qa-isolation-policy';

const IO_MS = 10_000;
const SETTLE_MS = 45_000;
const BODY_CAP = 512 * 1024;
const pendingBodies = new Map<Response, Buffer>();
const diagnostics: Array<{ status: number; bytes: number; consumed: boolean }> = [];
type CaptureContract = { method: 'PUT' | 'POST'; path: string; status: number; mime: 'json' | 'problem'; data: unknown };
type Scope = { closed: boolean; failed: boolean; active: Set<Promise<void>>; ownedBodies: Set<Buffer> };
const scopes = new Set<Scope>();
async function deadline<T>(operation: Promise<T>, label: string, milliseconds = IO_MS): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try { return await Promise.race([operation, new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} exceeded its finite bound; capture is not qualified`)), milliseconds);
  })]); } finally { if (timer) clearTimeout(timer); }
}
function exactData(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
  if (Array.isArray(left) || Array.isArray(right)) return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => exactData(value, right[index]));
  const first = left as Record<string, unknown>, second = right as Record<string, unknown>;
  const keys = Object.keys(first).sort(), other = Object.keys(second).sort();
  return keys.length === other.length && keys.every((key, index) => key === other[index] && exactData(first[key], second[key]));
}
function abandon(scope: Scope) {
  scope.closed = true; scope.failed = true;
  for (const body of scope.ownedBodies) body.fill(0);
}
function live(scope: Scope) {
  if (scope.closed || scope.failed) throw new Error('Original native capture was abandoned; no late body ownership or delivery is permitted');
}
export async function captureOriginalNativeResponse(page: Page, contract: CaptureContract,
  action: () => Promise<Response>): Promise<Response> {
  expect(new URL(page.url()).origin === QA_ORIGIN, 'Capture uses the exact guarded origin').toBe(true);
  expect(pendingBodies.size, 'Prior original body consumed before a new capture').toBe(0);
  expect(scopes.size, 'No prior unsettled original capture scope').toBe(0);
  const scope: Scope = { closed: false, failed: false, active: new Set(), ownedBodies: new Set() };
  scopes.add(scope);
  let originalRequest: Request | undefined, originalBody: Buffer | undefined;
  let requests = 0;
  const handlerFailures: unknown[] = [];
  let resolveCapture!: () => void, rejectCapture!: (failure: unknown) => void;
  const captured = new Promise<void>((resolve, reject) => { resolveCapture = resolve; rejectCapture = reject; });
  // A route can fail between installation and action startup. Preserve its rejection
  // without an unhandled rejection; the original deferred is still awaited below.
  void captured.catch(() => undefined);
  const pattern = `${QA_ORIGIN}${contract.path}`;
  const runHandler = async (route: Route) => {
    let upstream: APIResponse | undefined, localBody: Buffer | undefined;
    let transferred = false;
    const failures: unknown[] = [];
    try {
      try {
        live(scope);
        requests = Math.min(requests + 1, 2);
        const request = route.request(), url = new URL(request.url());
        const raw = request.postData() ?? '';
        if (Buffer.byteLength(raw, 'utf8') > 8192) throw new Error('Original native request exceeds its 8-KiB byte bound');
        let data: unknown;
        try { data = JSON.parse(raw); } catch { throw new Error('Original request JSON is invalid; raw fields excluded'); }
        if (requests !== 1 || url.origin !== QA_ORIGIN || url.pathname !== contract.path || url.search !== ''
          || request.method() !== contract.method || request.frame().page() !== page || !exactData(data, contract.data)) {
          throw new Error('Original request does not match the exact scoped native contract');
        }
        originalRequest = request;
        // Installed guard checks URL/response and forces zero redirects. Exactly
        // this original request is fetched once; no payload/URL override is used.
        upstream = await route.fetch({ timeout: IO_MS, maxRetries: 0, maxRedirects: 0 });
        live(scope);
        const type = upstream.headers()['content-type'] ?? '';
        const wanted = contract.mime === 'problem' ? /^application\/problem\+json(?:\s*;|$)/i : /^application\/json(?:\s*;|$)/i;
        if (upstream.url() !== pattern || upstream.status() !== contract.status || !wanted.test(type)) {
          throw new Error('Original native response URL/status/content type does not match the capture contract');
        }
        const body = await deadline(upstream.body(), 'Original native body read');
        live(scope); // A timed-out/duplicate/closed scope cannot allocate a late clone.
        if (body.length > BODY_CAP) throw new Error('Original native body exceeds its 512-KiB bound');
        localBody = Buffer.from(body); scope.ownedBodies.add(localBody);
        live(scope);
        // Original upstream response is delivered unchanged, with no body/status/
        // header override. An already-started native operation cannot be cancelled
        // by Promise.race; uncertainty stays failed and guarded cleanup remains owner.
        await deadline(route.fulfill({ response: upstream }), 'Original native response fulfillment');
        live(scope);
      } catch (failure) { failures.push(failure); abandon(scope); }
      if (upstream) {
        const disposed = await Promise.allSettled([deadline(upstream.dispose(), 'Original native API response disposal')]);
        if (disposed[0].status === 'rejected') { failures.push(disposed[0].reason); abandon(scope); }
      }
      if (failures.length) throw new AggregateError(failures, 'Original native capture/read/fulfill/disposal failed');
      live(scope);
      if (!localBody || requests !== 1) throw new Error('Original native capture did not complete exactly once');
      // Transfer only after complete verified original I/O/disposal success. Scope
      // still owns this clone until all handlers, removal and browser binding pass.
      originalBody = localBody; transferred = true; resolveCapture();
    } catch (failure) {
      abandon(scope); rejectCapture(failure);
      throw failure;
    } finally {
      if (localBody && (!transferred || scope.failed || scope.closed)) {
        localBody.fill(0); scope.ownedBodies.delete(localBody);
      }
    }
  };
  const handler = (route: Route): Promise<void> => {
    const task = runHandler(route);
    scope.active.add(task);
    void task.then(
      () => { scope.active.delete(task); },
      failure => { handlerFailures.push(failure); scope.active.delete(task); abandon(scope); },
    );
    return task;
  };
  const failures: unknown[] = [];
  let response: Response | undefined, publication = false;
  try {
    try { await deadline(page.route(pattern, handler), 'Exact owned capture route installation'); }
    catch (failure) { failures.push(failure); abandon(scope); }
    if (!failures.length) {
      const settled = await Promise.allSettled([
        deadline(Promise.resolve().then(action), 'Original native action settlement', SETTLE_MS)
          .catch(failure => { abandon(scope); rejectCapture(failure); throw failure; }),
        deadline(captured, 'Original native capture settlement', SETTLE_MS)
          .catch(failure => { abandon(scope); throw failure; }),
      ]);
      for (const result of settled) if (result.status === 'rejected') failures.push(result.reason);
      if (settled[0].status === 'fulfilled') response = settled[0].value;
      if (failures.length) abandon(scope);
    }
    // Stop admission first, remove only this exact callback, then settle every
    // tracked callback. unroute alone does not drain already-running handlers.
    scope.closed = true;
    const removed = await Promise.allSettled([deadline(page.unroute(pattern, handler), 'Exact owned capture route removal')]);
    if (removed[0].status === 'rejected') { failures.push(removed[0].reason); abandon(scope); }
    try {
      await deadline((async () => {
        while (scope.active.size) await Promise.allSettled([...scope.active]);
      })(), 'Every original capture handler settlement', SETTLE_MS);
    } catch (failure) { failures.push(failure); abandon(scope); }
    failures.push(...handlerFailures);
    if (scope.failed || scope.active.size || !response || !originalRequest || response.request() !== originalRequest
      || response.status() !== contract.status || !originalBody || requests !== 1) {
      failures.push(new Error('Original native body is not bound to one completely settled browser Request/response'));
    }
    if (diagnostics.length >= 3) failures.push(new Error('Original native capture diagnostics exceed this lane inventory'));
    if (failures.length) throw new AggregateError(failures, 'Original native action/capture/removal/handler settlement failed');
    pendingBodies.set(response!, originalBody!);
    scope.ownedBodies.delete(originalBody!); publication = true;
    diagnostics.push({ status: contract.status, bytes: originalBody!.length, consumed: false });
    return response!;
  } finally {
    scope.closed = true;
    if (!publication) abandon(scope);
    // If settlement was uncertain, retain the failed scope until final test cleanup
    // can zero any owned clone again. Late callbacks cannot allocate or publish.
    if (scope.active.size === 0) scopes.delete(scope);
  }
}
export async function consumeOriginalNativeJson<T>(response: Response): Promise<T> {
  const body = pendingBodies.get(response);
  if (!body || pendingBodies.size !== 1) throw new Error('Exactly one original owned native body must be available for consumption');
  try {
    let value: T;
    try { value = JSON.parse(body.toString('utf8')) as T; }
    catch { throw new Error('Original native response JSON is invalid; raw fields excluded'); }
    diagnostics[diagnostics.length - 1].consumed = true;
    return value;
  } finally { body.fill(0); pendingBodies.delete(response); }
}
export function finishOriginalNativeCaptures() {
  const unconsumed = pendingBodies.size, unsettledScopes = scopes.size;
  for (const scope of scopes) abandon(scope);
  for (const body of pendingBodies.values()) body.fill(0);
  pendingBodies.clear(); scopes.clear();
  const facts = [...diagnostics]; diagnostics.length = 0;
  if (unconsumed || unsettledScopes || facts.some(row => !row.consumed)) {
    throw new Error('Original native capture was not consumed and completely settled before owned teardown');
  }
  return facts;
}
