import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSeededTotpAllocator, readSeededMfaIdentity } from '../e2e/support';

// RFC 6238's ASCII test secret encoded as base32; this is public test material.
const secret = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
afterEach(() => vi.useRealTimers());

function harness(now: number) {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  const sleep = vi.fn((milliseconds: number) => new Promise<void>(resolve => setTimeout(resolve, milliseconds)));
  return { allocate: createSeededTotpAllocator({ now: Date.now, sleep }), sleep };
}

describe('seeded MFA fresh-code allocator', () => {
  it('waits on the first allocation to avoid a claim from a prior process, then generates the real current RFC code', async () => {
    const { allocate, sleep } = harness(28_000);
    let settled = false;
    const code = allocate('tenant:admin', secret).then(value => { settled = true; return value; });
    expect(sleep).toHaveBeenCalledExactlyOnceWith(2_250);
    await vi.advanceTimersByTimeAsync(2_249);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(Date.now()).toBe(30_250);
    expect(await code).toBe('287082');
  });

  it('waits for another genuinely new step before a repeat login by the same identity', async () => {
    const { allocate, sleep } = harness(56_000);
    const first = allocate('tenant:admin', secret);
    await vi.advanceTimersByTimeAsync(4_250);
    expect(await first).toBe('359152');
    const budget = vi.fn();
    const next = allocate('tenant:admin', secret, budget);
    let settled = false;
    void next.then(() => { settled = true; });
    expect(sleep).toHaveBeenLastCalledWith(30_000);
    expect(budget).toHaveBeenCalledExactlyOnceWith(30_000);
    await vi.advanceTimersByTimeAsync(29_999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await next).toBe('969429');
  });

  it('never gives concurrent calls the same step and fails closed when another fresh step exceeds the bounded wait', async () => {
    const { allocate } = harness(56_000);
    const first = allocate('tenant:admin', secret);
    const second = allocate('tenant:admin', secret);
    const denied = expect(second).rejects.toThrow('bounded wait');
    await vi.advanceTimersByTimeAsync(4_250);
    expect(await first).toBe('359152');
    await denied;
  });

  it('keeps users and tenant identities independent even when their fixture secrets match', async () => {
    const { allocate, sleep } = harness(56_000);
    const pending = [
      allocate('tenant:admin', secret),
      allocate('tenant:superadmin', secret),
      allocate('other-tenant:admin', secret),
    ];
    expect(sleep).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(4_250);
    expect(await Promise.all(pending)).toEqual(['359152', '359152', '359152']);
  });

  it('waits beyond a near-boundary first allocation rather than submitting the current code', async () => {
    const { allocate, sleep } = harness(59_500);
    const pending = allocate('tenant:admin', secret);
    expect(sleep).toHaveBeenCalledExactlyOnceWith(750);
    await vi.advanceTimersByTimeAsync(749);
    expect(Date.now()).toBe(60_249);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBe('359152');
  });

  it('fails closed when the clock never advances rather than looping or predicting a valid code', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const allocate = createSeededTotpAllocator({ now: () => 56_000, sleep });
    await expect(allocate('tenant:admin', secret)).rejects.toThrow('bounded wait');
    expect(sleep).toHaveBeenCalledTimes(7);
  });
});


describe('seeded MFA authoritative API identity proof', () => {
  const binding = { publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed238', workspaceScope: 'A'.repeat(43), sessionScope: 'B'.repeat(43) };
  const expected = { username: 'e2e.admin', workspaceName: 'E2E Operations Diner', verified: true, binding };
  const user = () => ({ ...binding, username: expected.username, workspaceName: expected.workspaceName, mfaRequired: true, mfaVerified: true, pinResetRequired: false });
  function api(payload: unknown, status = 200) {
    const response = { status: () => status, json: vi.fn().mockResolvedValue(payload), dispose: vi.fn().mockResolvedValue(undefined) };
    return { request: { get: vi.fn().mockResolvedValue(response) }, response };
  }

  it('accepts a fresh verified API identity matching the same user, workspace and session', async () => {
    const { request, response } = api({ user: user() });
    expect(await readSeededMfaIdentity(request, expected)).toEqual(binding);
    expect(request.get).toHaveBeenCalledExactlyOnceWith('/api/v2/auth/me', { maxRedirects: 0, timeout: 10_000 });
    expect(response.json).toHaveBeenCalledOnce();
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it('captures the real unverified pre-MFA binding for a later exact comparison', async () => {
    const { request } = api({ user: { ...user(), mfaVerified: false } });
    expect(await readSeededMfaIdentity(request, { ...expected, verified: false, binding: undefined })).toEqual(binding);
  });

  it.each([
    ['missing user', undefined], ['array user', []],
    ['unverified session', { ...user(), mfaVerified: false }],
    ['missing verification', { ...user(), mfaVerified: undefined }],
    ['MFA disabled', { ...user(), mfaRequired: false }],
    ['missing required state', { ...user(), mfaRequired: undefined }],
    ['pending PIN reset', { ...user(), pinResetRequired: true }],
    ['different username', { ...user(), username: 'other.admin' }],
    ['different workspace', { ...user(), workspaceName: 'Other workspace' }],
    ['different user identity', { ...user(), publicUserId: 'f6776d21-bb21-4c35-a6ed-5da8df5ed239' }],
    ['different tenant scope', { ...user(), workspaceScope: 'C'.repeat(43) }],
    ['different session scope', { ...user(), sessionScope: 'C'.repeat(43) }],
    ['missing public identity', { ...user(), publicUserId: undefined }],
    ['malformed tenant scope', { ...user(), workspaceScope: 'invalid' }],
    ['malformed session scope', { ...user(), sessionScope: 'invalid' }],
  ])('rejects %s without trusting the browser MFA response body', async (_label, candidate) => {
    const { request, response } = api({ user: candidate });
    await expect(readSeededMfaIdentity(request, expected)).rejects.toThrow('Seeded MFA');
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it.each([302, 401, 403, 500, 503])('rejects HTTP %s without reading a purported success body', async status => {
    const { request, response } = api({ user: user() }, status);
    await expect(readSeededMfaIdentity(request, expected)).rejects.toThrow(`HTTP ${status}`);
    expect(response.json).not.toHaveBeenCalled();
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it('rejects malformed JSON and still disposes the independent API response', async () => {
    const { request, response } = api(undefined);
    response.json.mockRejectedValue(new SyntaxError('Invalid JSON'));
    await expect(readSeededMfaIdentity(request, expected)).rejects.toThrow('Seeded MFA identity response could not be read.');
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it('propagates transport failure without manufacturing verification', async () => {
    const request = { get: vi.fn().mockRejectedValue(new Error('Transport unavailable')) };
    await expect(readSeededMfaIdentity(request, expected)).rejects.toThrow('Seeded MFA identity request failed.');
  });

  it('bounds an unavailable API body read, redacts parser details and disposes the response', async () => {
    vi.useFakeTimers();
    const { request, response } = api(undefined);
    response.json.mockImplementation(() => new Promise(() => {}));
    const read = readSeededMfaIdentity(request, expected);
    const rejected = expect(read).rejects.toThrow('Seeded MFA identity response could not be read.');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
    expect(response.dispose).toHaveBeenCalledOnce();
  });

  it('bounds API response disposal rather than silently retaining the response', async () => {
    vi.useFakeTimers();
    const { request, response } = api({ user: user() });
    response.dispose.mockImplementation(() => new Promise(() => {}));
    const read = readSeededMfaIdentity(request, expected);
    const rejected = expect(read).rejects.toThrow('Seeded MFA identity response cleanup failed.');
    await vi.advanceTimersByTimeAsync(5_000);
    await rejected;
  });

});
