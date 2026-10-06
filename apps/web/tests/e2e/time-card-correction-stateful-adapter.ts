import { createHash } from 'node:crypto';
import type { TimeCardCorrectionRequest, TimeCardRecord } from '@lunchlineup/api-contract';
import type { Page, Route } from '@playwright/test';

// Closed local browser-route model only: no service start, SQL, native owner,
// identity, wallet, quota, payroll-lock or immutable-audit simulation/claim.
export const STAFF = '20000000-0000-4000-8000-000000000001';
export const MANAGER = '20000000-0000-4000-8000-000000000002';
const ADMIN = '20000000-0000-4000-8000-000000000101';
export const LOCATION = '10000000-0000-4000-8000-000000000011';
const ANNEX = '10000000-0000-4000-8000-000000000012';
export const CARD = '79000000-0000-4000-8000-000000000101';
export const OTHER = '79000000-0000-4000-8000-000000000102';
const REPLACEMENT = '79000000-0000-4000-8000-000000000103';
const BASE = '/api/v2/time-cards';
export const CORRECTION_URL = `${BASE}/${CARD}/correction`;
const PROBE = 'x-timecard-fixture-probe';
const digest = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;
function deferred<T>() {
  let resolve!: (value: T) => void, reject!: (error: unknown) => void;
  const promise = new Promise<T>((ok, fail) => { resolve = ok; reject = fail; });
  void promise.catch(() => undefined);
  return { promise, resolve, reject };
}
export type ResponseRecord = {
  method: string; path: string; probe: boolean; requestKey: string | null; body: unknown; status: number;
  originalHeaders: Record<string, string>; deliveryHeaders: Record<string, string>;
  bytes: Buffer; sha256: string; effects: number;
};
function frame(headers: Record<string, string>, bytes: Buffer) {
  // Decoded bytes must never inherit compression/chunking/old length framing.
  const omitted = new Set(['content-encoding', 'transfer-encoding', 'content-length', 'connection', 'keep-alive']);
  return { ...Object.fromEntries(Object.entries(headers).filter(([key]) => !omitted.has(key.toLowerCase()))),
    'content-length': String(bytes.length) };
}
function instant(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value ? date.getTime() : null;
}

export async function installTimeCardCorrectionAdapter(page: Page, open = false) {
  const now = Math.floor(Date.now() / 60_000) * 60_000;
  const end = now - 24 * 60 * 60_000, start = end - 8 * 60 * 60_000;
  const version = end + 60_000;
  function seed(id: string, userId: string, name: string, locationId = LOCATION): TimeCardRecord {
    const isOpen = open && id === CARD;
    // Replacement staff history precedes this card, so populated controls are
    // lawful disjoint windows rather than an overlap a native owner would refuse.
    const shift = id === REPLACEMENT ? -48 * 60 * 60_000 : 0;
    const cardStart = start + shift, cardEnd = end + shift;
    return { id, userId, locationId, shiftId: null, clockInAt: new Date(cardStart).toISOString(),
      clockOutAt: isOpen ? null : new Date(cardEnd).toISOString(), breakMinutes: 0,
      status: isOpen ? 'OPEN' : 'CLOSED', revision: 1,
      grossMinutes: isOpen ? Math.floor((now - start) / 60_000) : 480,
      workedMinutes: isOpen ? Math.floor((now - start) / 60_000) : 480,
      notes: null, createdAt: new Date(cardStart).toISOString(), updatedAt: new Date(version).toISOString(),
      displayTimeZone: 'UTC', breaks: [], user: { id: userId, name, username: null, role: userId === STAFF ? 'STAFF' : 'MANAGER' },
      location: { id: locationId, name: locationId === LOCATION ? 'Correction Kitchen' : 'Correction Annex', timezone: 'UTC' } };
  }
  const cards = new Map<string, TimeCardRecord>([
    [CARD, seed(CARD, STAFF, 'Mock Staff')], [OTHER, seed(OTHER, MANAGER, 'Mock Manager')],
    [REPLACEMENT, seed(REPLACEMENT, STAFF, 'Mock Staff', ANNEX)],
  ]);
  const initial = copy([...cards.values()]);
  const ledger: ResponseRecord[] = [], failures: unknown[] = [], settlements: Promise<void>[] = [];
  let effects = 0, closing = false;
  type Hold = { observed: ReturnType<typeof deferred<unknown>>; ready: ReturnType<typeof deferred<ResponseRecord>>;
    release: ReturnType<typeof deferred<void>>; finished: ReturnType<typeof deferred<void>> };
  const holds: Hold[] = [];
  let pendingHold: Hold | undefined;
  function problem(status: number, code: string, message: string, path: string) {
    return { type: `https://lunchlineup.com/problems/${code.replace(/_/g, '-')}`, title: 'Time-card correction refused',
      status, code, message, detail: message, instance: path, requestId: 'timecard-fixture' };
  }
  function correct(id: string, body: unknown, path: string): { status: number; payload: unknown } {
    const row = cards.get(id);
    if (!row) throw new Error('Unmodeled correction resource');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error('Unmodeled correction body');
    const payload = body as TimeCardCorrectionRequest;
    const keys = Object.keys(payload).sort();
    const expected = ['clockInAt', 'clockOutAt', 'expectedUpdatedAt', 'reason',
      ...(Object.hasOwn(payload, 'breakIntervals') ? ['breakIntervals'] : [])].sort();
    if (JSON.stringify(keys) !== JSON.stringify(expected)) throw new Error('Unexpected exact correction fields');
    const begin = instant(payload.clockInAt), finish = payload.clockOutAt === null ? null : instant(payload.clockOutAt);
    if (begin === null || (payload.clockOutAt !== null && finish === null) || instant(payload.expectedUpdatedAt) === null
      || typeof payload.reason !== 'string' || payload.reason.trim().length < 5 || payload.reason.trim().length > 500) {
      throw new Error('Unmodeled correction field shape');
    }
    const effectiveEnd = finish ?? now;
    if (effectiveEnd <= begin || effectiveEnd - begin > 31 * 24 * 60 * 60_000) {
      return { status: 422, payload: problem(422, 'invalid_time_card_input', 'Clock out must be after clock in.', path) };
    }
    const intervals = Object.hasOwn(payload, 'breakIntervals') ? payload.breakIntervals! : row.breaks;
    if (!Array.isArray(intervals) || intervals.length > 24) throw new Error('Unmodeled break interval shape');
    let previous = begin, breakMinutes = 0;
    for (const interval of intervals) {
      const a = instant(interval.startAt), b = instant(interval.endAt);
      if (a === null || b === null || a < begin || b > effectiveEnd || b <= a || a < previous || (b - a) % 60_000 !== 0) {
        throw new Error('Unmodeled break interval bounds');
      }
      previous = b; breakMinutes += (b - a) / 60_000;
    }
    if (!Object.hasOwn(payload, 'breakIntervals') && intervals.length === 0) breakMinutes = row.breakMinutes;
    const grossMinutes = Math.floor((effectiveEnd - begin) / 60_000);
    if (breakMinutes > 0 && breakMinutes >= grossMinutes) throw new Error('Unmodeled complete break window');
    // Native validation precedes CAS. This bounded model implements only the
    // 422 invalid-window and exact version CAS branches exercised by this file.
    if (payload.expectedUpdatedAt !== row.updatedAt) {
      return { status: 409, payload: problem(409, 'concurrent_time_card_change',
        'This time card changed while you were editing it. Refresh and try again.', path) };
    }
    const revision = row.revision + 1;
    const next: TimeCardRecord = { ...row, clockInAt: payload.clockInAt!, clockOutAt: payload.clockOutAt!,
      status: finish === null ? 'OPEN' : 'CLOSED', grossMinutes, workedMinutes: grossMinutes - breakMinutes,
      breakMinutes, revision, updatedAt: new Date(version + (revision - 1) * 1000).toISOString(),
      breaks: Object.hasOwn(payload, 'breakIntervals') ? intervals.map((interval, index) => ({
        id: `79000000-0000-4000-8000-${String(500 + index).padStart(12, '0')}`,
        startAt: interval.startAt, endAt: interval.endAt,
      })) : row.breaks };
    cards.set(id, next); effects += 1;
    return { status: 200, payload: copy(next) };
  }
  const patterns = ['**/api/v2/time-cards**', '**/api/v2/shifts/staff-roster**', '**/api/v2/locations?**'];
  const run = async (route: Route) => {
    let hold: Hold | undefined;
    try {
      if (closing) throw new Error('Route entered after adapter close');
      const request = route.request(), url = new URL(request.url()), path = url.pathname;
      const method = request.method(), probe = request.headers()[PROBE] === 'readback';
      if (ledger.length >= 100 || (request.postDataBuffer()?.length ?? 0) > 8192) throw new Error('Fixture ledger/request bound exceeded');
      const body: unknown = method === 'PATCH' ? request.postDataJSON() : null;
      let status = 200, payload: unknown;
      if (method === 'GET' && path === '/api/v2/shifts/staff-roster' && url.search === '?limit=200') {
        payload = { data: [{ id: STAFF, name: 'Mock Staff', role: 'STAFF' }, { id: MANAGER, name: 'Mock Manager', role: 'MANAGER' }],
          pagination: { hasMore: false, nextCursor: null } };
      } else if (method === 'GET' && path === '/api/v2/locations' && url.search === '?limit=200') {
        payload = { data: [cards.get(CARD)!.location, cards.get(REPLACEMENT)!.location],
          pagination: { hasMore: false, nextCursor: null } };
      } else if (method === 'GET' && (path === BASE || path === `${BASE}/active`)) {
        const allowed = path === BASE ? ['limit', 'userId'] : ['userId'];
        if ([...url.searchParams.keys()].some(key => !allowed.includes(key))
          || (path === BASE && url.searchParams.get('limit') !== '100')) throw new Error('Unmodeled card query');
        const user = url.searchParams.get('userId');
        if (![STAFF, MANAGER, ADMIN].includes(user ?? '')) throw new Error('Unmodeled card user');
        const rows = [...cards.values()].filter(row => row.userId === user).map(copy);
        payload = path.endsWith('/active') ? { data: rows.find(row => row.status === 'OPEN') ?? null }
          : { data: rows, pagination: { limit: 100, maxLimit: 200, returned: rows.length, hasMore: false,
            nextCursor: null, window: { startDate: null, endDate: null } } };
      } else if (method === 'GET' && [CARD, OTHER, REPLACEMENT].some(id => path === `${BASE}/${id}`) && !url.search) {
        payload = copy(cards.get(path.split('/').at(-1)!)!);
      } else if (method === 'PATCH' && path === CORRECTION_URL && !url.search) {
        if (!probe && pendingHold) { hold = pendingHold; pendingHold = undefined; hold.observed.resolve(copy(body)); }
        ({ status, payload } = correct(CARD, body, path));
      } else {
        throw new Error(`Unexpected fixture request ${method} ${path}`);
      }
      const bytes = Buffer.from(JSON.stringify(payload));
      const originalHeaders = { 'content-type': status >= 400 ? 'application/problem+json' : 'application/json', 'cache-control': 'private, no-store' };
      const record: ResponseRecord = { method, path, probe, requestKey: request.headers()['idempotency-key'] ?? null, body: copy(body), status, originalHeaders,
        deliveryHeaders: frame(originalHeaders, bytes), bytes, sha256: digest(bytes), effects };
      ledger.push(record); hold?.ready.resolve(record);
      if (hold) await hold.release.promise;
      await route.fulfill({ status, headers: record.deliveryHeaders, body: bytes });
      hold?.finished.resolve();
    } catch (error) {
      failures.push(error); hold?.observed.reject(error); hold?.ready.reject(error); hold?.finished.reject(error);
      await route.abort().catch(error => failures.push(error));
    }
  };
  const handler = (route: Route) => { const done = run(route); settlements.push(done); return done; };
  for (const pattern of patterns) await page.route(pattern, handler);
  return {
    initial, ledger,
    holdNext() {
      if (pendingHold) throw new Error('A correction hold is already armed');
      const hold: Hold = { observed: deferred<unknown>(), ready: deferred<ResponseRecord>(),
        release: deferred<void>(), finished: deferred<void>() };
      holds.push(hold); pendingHold = hold;
      return { observed: hold.observed.promise, ready: hold.ready.promise, finished: hold.finished.promise,
        release: () => hold.release.resolve() };
    },
    async read(id: string) {
      if (![CARD, OTHER, REPLACEMENT].includes(id)) throw new Error('Readback target not declared');
      return browserProbe(page, `${BASE}/${id}`, 'GET');
    },
    async compete(payload: TimeCardCorrectionRequest) {
      return browserProbe(page, CORRECTION_URL, 'PATCH', payload);
    },
    async close() {
      // Release every armed barrier, then drain the actual handler promises
      // (abort included), before removing routes; never detach cleanup.
      holds.forEach(hold => hold.release.resolve());
      let settled = 0;
      const drain = async () => {
        while (settled < settlements.length) {
          const batch = settlements.slice(settled); settled += batch.length;
          for (const outcome of await Promise.allSettled(batch)) {
            if (outcome.status === 'rejected') failures.push(outcome.reason);
          }
        }
      };
      await drain();
      closing = true;
      for (const pattern of patterns) await page.unroute(pattern, handler).catch(error => failures.push(error));
      await drain();
      if (failures.length) throw new AggregateError(failures, 'Time Card adapter refused an unexpected request or cleanup');
    },
  };
}

async function browserProbe(page: Page, path: string, method: 'GET' | 'PATCH', body?: TimeCardCorrectionRequest) {
  // This is a separate actual HTTP GET/PATCH through the local route adapter,
  // not a DOM-derived oracle and not a durable backend/database proof.
  const wire = await page.evaluate(async ({ path, method, body, probe }) => {
    const csrf = document.cookie.split('; ').find(pair => pair.startsWith('csrf_token='));
    const response = await fetch(path, { method, credentials: 'include', headers: {
      [probe]: 'readback', ...(body ? { 'content-type': 'application/json',
        'x-csrf-token': csrf ? decodeURIComponent(csrf.split('=')[1] ?? '') : '' } : {}),
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
    return { status: response.status, headers: Object.fromEntries(response.headers.entries()),
      bytes: Array.from(new Uint8Array(await response.arrayBuffer())) };
  }, { path, method, body, probe: PROBE });
  const bytes = Buffer.from(wire.bytes);
  return { status: wire.status, originalHeaders: wire.headers, bytes,
    sha256: digest(bytes), payload: JSON.parse(bytes.toString('utf8')) as TimeCardRecord | { code: string } };
}
