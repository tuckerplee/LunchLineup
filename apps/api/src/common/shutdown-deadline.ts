export const DEFAULT_PROCESS_SHUTDOWN_DEADLINE_MS = 30_000;

type ShutdownSignal = 'SIGINT' | 'SIGTERM';

type ShutdownRuntimeProcess = {
    once(signal: ShutdownSignal, listener: () => void): unknown;
    off(signal: ShutdownSignal, listener: () => void): unknown;
    exit(code: number): never;
};

type ShutdownTimer = ReturnType<typeof setTimeout> & { unref?: () => unknown };

export function resolveProcessShutdownDeadlineMs(value = process.env.PROCESS_SHUTDOWN_DEADLINE_MS): number {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    return Number.isFinite(parsed) && parsed >= 5_000 && parsed <= 120_000
        ? parsed
        : DEFAULT_PROCESS_SHUTDOWN_DEADLINE_MS;
}

export function createProcessShutdownDeadlineHandler(options: {
    deadlineMs: number;
    exit: (code: number) => never | void;
    log: (message: string) => void;
    schedule?: (callback: () => void, delayMs: number) => ShutdownTimer;
}): (signal: ShutdownSignal) => void {
    let armed = false;
    const schedule = options.schedule ?? setTimeout;
    return (signal) => {
        if (armed) return;
        armed = true;
        const timer = schedule(() => {
            options.log(`Process shutdown deadline exceeded signal=${signal}`);
            options.exit(1);
        }, options.deadlineMs);
        timer.unref?.();
    };
}

export function installProcessShutdownDeadline(
    runtimeProcess: ShutdownRuntimeProcess = process,
    deadlineMs = resolveProcessShutdownDeadlineMs(),
): () => void {
    const handle = createProcessShutdownDeadlineHandler({
        deadlineMs,
        exit: (code) => runtimeProcess.exit(code),
        log: (message) => console.error(message),
    });
    const onSigint = () => handle('SIGINT');
    const onSigterm = () => handle('SIGTERM');
    runtimeProcess.once('SIGINT', onSigint);
    runtimeProcess.once('SIGTERM', onSigterm);
    return () => {
        runtimeProcess.off('SIGINT', onSigint);
        runtimeProcess.off('SIGTERM', onSigterm);
    };
}
