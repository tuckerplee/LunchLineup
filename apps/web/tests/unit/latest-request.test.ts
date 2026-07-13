import { describe, expect, it } from 'vitest';
import { createLatestRequestGate } from '../../lib/latest-request';

describe('latest request gate', () => {
    it('rejects an older completion after a newer scoped request begins', () => {
        const gate = createLatestRequestGate<string>();
        const first = gate.begin('employee-a');
        const second = gate.begin('employee-b');

        expect(gate.isLatest(first)).toBe(false);
        expect(gate.isLatest(second)).toBe(true);
    });

    it('invalidates an in-flight request before its replacement begins', () => {
        const gate = createLatestRequestGate<string>();
        const request = gate.begin('2026-07-11');

        gate.invalidate();

        expect(gate.isLatest(request)).toBe(false);
    });
});
