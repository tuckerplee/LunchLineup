import { describe, expect, it } from 'vitest';
import { ClockInRequestKey, isTimeCardForEmployee } from '../../app/dashboard/time-cards/time-card-request';

describe('time-card employee request scope', () => {
    it('only permits an active card owned by the selected employee', () => {
        expect(isTimeCardForEmployee({ userId: 'employee-a' }, 'employee-a')).toBe(true);
        expect(isTimeCardForEmployee({ userId: 'employee-a' }, 'employee-b')).toBe(false);
        expect(isTimeCardForEmployee(null, 'employee-a')).toBe(false);
    });

    it('keeps one clock-in key through retries and rotates after reset', () => {
        let sequence = 0;
        const keys = new ClockInRequestKey(() => 'request-' + (++sequence));

        expect(keys.current()).toBe('request-1');
        expect(keys.current()).toBe('request-1');
        keys.reset();
        expect(keys.current()).toBe('request-2');
    });});
