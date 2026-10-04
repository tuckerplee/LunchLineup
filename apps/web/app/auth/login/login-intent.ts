export type LoginAttempt = { controller: AbortController };

/** Owns one browser intent, including fetches which settle after cancellation. */
export function createLoginIntent() {
    let active: LoginAttempt | null = null;
    return {
        begin(): LoginAttempt | null {
            if (active) return null;
            active = { controller: new AbortController() };
            return active;
        },
        current(attempt: LoginAttempt): boolean {
            return active === attempt && !attempt.controller.signal.aborted;
        },
        finish(attempt: LoginAttempt): boolean {
            if (active !== attempt || attempt.controller.signal.aborted) return false;
            active = null;
            return true;
        },
        cancel(): void {
            active?.controller.abort();
            active = null;
        },
    };
}
