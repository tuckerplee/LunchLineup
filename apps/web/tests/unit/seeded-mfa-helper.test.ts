import { afterEach, describe, expect, it, vi } from 'vitest';
import { createSeededTotpAllocator } from '../e2e/support';

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
