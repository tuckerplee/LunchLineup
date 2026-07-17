import { describe, expect, it, vi } from 'vitest';
import {
    createProcessShutdownDeadlineHandler,
    resolveProcessShutdownDeadlineMs,
} from './shutdown-deadline';

describe('process shutdown deadline', () => {
    it('uses a bounded configured deadline', () => {
        expect(resolveProcessShutdownDeadlineMs('5000')).toBe(5_000);
        expect(resolveProcessShutdownDeadlineMs('120000')).toBe(120_000);
        expect(resolveProcessShutdownDeadlineMs('4999')).toBe(30_000);
        expect(resolveProcessShutdownDeadlineMs('120001')).toBe(30_000);
    });

    it('arms once, unreferences the watchdog, and forces a failed exit at expiry', () => {
        let expire!: () => void;
        const unref = vi.fn();
        const exit = vi.fn();
        const log = vi.fn();
        const schedule = vi.fn((callback: () => void) => {
            expire = callback;
            return { unref } as any;
        });
        const handle = createProcessShutdownDeadlineHandler({
            deadlineMs: 7_500,
            exit,
            log,
            schedule,
        });

        handle('SIGTERM');
        handle('SIGINT');
        expect(schedule).toHaveBeenCalledOnce();
        expect(schedule).toHaveBeenCalledWith(expect.any(Function), 7_500);
        expect(unref).toHaveBeenCalledOnce();
        expire();
        expect(log).toHaveBeenCalledWith('Process shutdown deadline exceeded signal=SIGTERM');
        expect(exit).toHaveBeenCalledWith(1);
    });
});
