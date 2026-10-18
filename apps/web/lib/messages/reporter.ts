import { fetchPublicApi } from '../client-api';
import type { ClientEvent } from './types';

export const MAX_BATCH = 20;
export const FLUSH_DELAY_MS = 2000;
/** Hard cap on the unsent queue so a failing endpoint cannot grow memory. */
export const MAX_QUEUED = 100;

export type EventSender = (events: ClientEvent[]) => Promise<void> | void;

/** Same-origin, CSRF-protected, keepalive POST. Failures are swallowed by the reporter. */
export const sendClientEvents: EventSender = async (events) => {
    await fetchPublicApi('/client-events', {
        method: 'POST',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ events }),
    });
};

export type ClientEventReporter = {
    report(event: ClientEvent): void;
    flush(): void;
    dispose(): void;
};

type ReporterOptions = {
    send?: EventSender;
    setTimer?: (callback: () => void, ms: number) => unknown;
    clearTimer?: (handle: unknown) => void;
};

/**
 * Collects tracking events and sends them in small batches (at most 20 each).
 * Sending is fire-and-forget: tracking can never block or fail a workflow, and
 * a failed batch is dropped rather than retried in a loop.
 */
export function createClientEventReporter(options: ReporterOptions = {}): ClientEventReporter {
    const send = options.send ?? sendClientEvents;
    const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
    const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));
    let queue: ClientEvent[] = [];
    let timer: unknown = null;

    const flush = () => {
        if (timer !== null) {
            clearTimer(timer);
            timer = null;
        }
        while (queue.length > 0) {
            const batch = queue.slice(0, MAX_BATCH);
            queue = queue.slice(MAX_BATCH);
            try {
                void Promise.resolve(send(batch)).catch(() => undefined);
            } catch {
                // Best effort only.
            }
        }
    };

    return {
        report(event) {
            queue.push(event);
            if (queue.length > MAX_QUEUED) queue = queue.slice(-MAX_QUEUED);
            if (queue.length >= MAX_BATCH) flush();
            else if (timer === null) timer = setTimer(flush, FLUSH_DELAY_MS);
        },
        flush,
        dispose() {
            flush();
        },
    };
}
