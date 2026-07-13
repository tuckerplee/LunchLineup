import { describe, expect, it } from 'vitest';
import {
    createPrintScheduleScope,
    isPrintScheduleScopeCurrent,
} from '../../app/dashboard/scheduling/print/print-schedule-scope';

describe('print schedule request scope', () => {
    it('requires both the selected date and requested location to match', () => {
        const loaded = createPrintScheduleScope('2026-07-11', 'location-a');

        expect(isPrintScheduleScopeCurrent(loaded, createPrintScheduleScope('2026-07-11', 'location-a'))).toBe(true);
        expect(isPrintScheduleScopeCurrent(loaded, createPrintScheduleScope('2026-07-12', 'location-a'))).toBe(false);
        expect(isPrintScheduleScopeCurrent(loaded, createPrintScheduleScope('2026-07-11', 'location-b'))).toBe(false);
    });
});
