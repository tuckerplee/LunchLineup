import { ConfigService } from '@nestjs/config';
import { Logger } from '@nestjs/common';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SchedulePublishedEmailService } from './schedule-published-email.service';

const liveKeyShape = `re_${'a'.repeat(32)}`;

describe('SchedulePublishedEmailService', () => {
    afterEach(() => {
        vi.useRealTimers();
        vi.restoreAllMocks();
    });

    it('is explicitly disabled by default without requiring provider credentials', async () => {
        const service = new SchedulePublishedEmailService(config({}), activeFeedback() as any);

        await expect(service.send(input())).resolves.toBe('disabled');
    });

    it('fails startup when enabled delivery lacks live provider configuration', () => {
        expect(() => new SchedulePublishedEmailService(config({
            SCHEDULE_PUBLISHED_EMAIL_ENABLED: 'true',
        }), activeFeedback() as any)).toThrow('RESEND_API_KEY');
        expect(() => new SchedulePublishedEmailService(config({
            SCHEDULE_PUBLISHED_EMAIL_ENABLED: 'true',
            RESEND_API_KEY: `re_dev_${'a'.repeat(32)}`,
            EMAIL_FROM: 'LunchLineup <no-reply@beta.lunchlineup.com>',
            APP_ORIGIN: 'https://beta.lunchlineup.com',
        }), activeFeedback() as any)).toThrow('live Resend API key');
        expect(() => new SchedulePublishedEmailService(config({
            SCHEDULE_PUBLISHED_EMAIL_ENABLED: 'true',
            RESEND_API_KEY: liveKeyShape,
            EMAIL_FROM: 'LunchLineup <no-reply@beta.lunchlineup.com>',
            APP_ORIGIN: 'http://beta.lunchlineup.com',
        }), activeFeedback() as any)).toThrow('canonical HTTPS origin');
    });

    it('sends escaped schedule details with a stable provider idempotency key', async () => {
        const service = enabledService();
        const send = vi.fn().mockResolvedValue({ data: { id: 'provider-1' }, error: null });
        (service as any).resend = { emails: { send } };

        await expect(service.send(input({
            title: 'Schedule <published>',
            body: 'Downtown & West: Jul 14 to Jul 20',
        }))).resolves.toBe('accepted');

        expect(send).toHaveBeenCalledOnce();
        const [payload, options] = send.mock.calls[0];
        expect(payload).toMatchObject({
            from: 'LunchLineup <no-reply@beta.lunchlineup.com>',
            to: 'staff@example.test',
            subject: 'Schedule <published>',
        });
        expect(payload.html).toContain('Schedule &lt;published&gt;');
        expect(payload.html).toContain('Downtown &amp; West');
        expect(payload.html).not.toContain('Schedule <published>');
        expect(payload.text).toContain('https://beta.lunchlineup.com/dashboard/scheduling');
        expect(options.idempotencyKey).toBe('schedule-published/outbox-1');
        expect(options.signal).toBeInstanceOf(AbortSignal);
    });

    it('skips provider handoff for suppressed and non-addressable recipients without logging PII', async () => {
        const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
        const feedback = { isSuppressed: vi.fn().mockResolvedValue(true) };
        const service = enabledService(feedback);
        const send = vi.fn();
        (service as any).resend = { emails: { send } };

        await expect(service.send(input())).resolves.toBe('suppressed');
        await expect(service.send(input({ recipientEmail: null }))).resolves.toBe('not_addressable');
        await expect(service.send(input({ recipientEmail: 'pin-user@staff.lunchlineup.local' })))
            .resolves.toBe('not_addressable');

        expect(send).not.toHaveBeenCalled();
        expect(JSON.stringify(warn.mock.calls)).not.toContain('staff@example.test');
    });

    it('rejects malformed provider identity and header content before handoff', async () => {
        const service = enabledService();
        const send = vi.fn();
        (service as any).resend = { emails: { send } };

        await expect(service.send(input({ outboxId: 'bad/identity' })))
            .rejects.toThrow('outbox identity is invalid');
        await expect(service.send(input({ title: 'Schedule published\r\nBcc: outsider@example.test' })))
            .rejects.toThrow('schedule email title is invalid');
        expect(send).not.toHaveBeenCalled();
    });

    it('keeps provider response details and recipient data out of failure diagnostics', async () => {
        const errorLog = vi.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
        const service = enabledService();
        const send = vi.fn().mockResolvedValue({
            data: null,
            error: {
                statusCode: 403,
                message: 'staff@example.test rejected Authorization: Bearer secret',
            },
        });
        (service as any).resend = { emails: { send } };

        await expect(service.send(input())).rejects.toThrow(
            'Schedule publication email provider rejected delivery',
        );

        const logs = JSON.stringify(errorLog.mock.calls);
        expect(logs).toContain('http_status=403');
        expect(logs).not.toContain('staff@example.test');
        expect(logs).not.toContain('Authorization');
        expect(logs).not.toContain('secret');
    });

    it('fails closed when a successful provider response has no message identity', async () => {
        const service = enabledService();
        const send = vi.fn().mockResolvedValue({ data: null, error: null });
        (service as any).resend = { emails: { send } };

        await expect(service.send(input())).rejects.toThrow('provider returned an invalid response');
    });

    it('bounds suppression plus provider delivery with one aborting deadline', async () => {
        vi.useFakeTimers();
        const feedback = {
            isSuppressed: vi.fn().mockImplementation(
                () => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 600)),
            ),
        };
        const service = enabledService(feedback, {
            SCHEDULE_PUBLISHED_EMAIL_PROVIDER_TIMEOUT_MS: '1000',
        });
        let providerCalled = false;
        (service as any).resend = {
            emails: {
                send: vi.fn().mockImplementation(() => {
                    providerCalled = true;
                    return Promise.resolve({ data: { id: 'provider-1' }, error: null });
                }),
            },
        };

        const delivery = service.send(input());
        await vi.advanceTimersByTimeAsync(600);
        expect(providerCalled).toBe(true);
        await expect(delivery).resolves.toBe('accepted');

        const stalledFeedback = {
            isSuppressed: vi.fn().mockImplementation(() => new Promise<boolean>(() => undefined)),
        };
        const stalled = enabledService(stalledFeedback, {
            SCHEDULE_PUBLISHED_EMAIL_PROVIDER_TIMEOUT_MS: '1000',
        });
        const timedOut = stalled.send(input());
        const rejection = expect(timedOut).rejects.toThrow('provider deadline exceeded');
        await vi.advanceTimersByTimeAsync(1000);
        await rejection;
    });
});

function enabledService(
    feedback?: { isSuppressed: ReturnType<typeof vi.fn> },
    overrides: Record<string, string> = {},
): SchedulePublishedEmailService {
    return new SchedulePublishedEmailService(config({
        SCHEDULE_PUBLISHED_EMAIL_ENABLED: 'true',
        SCHEDULE_PUBLISHED_EMAIL_PROVIDER_TIMEOUT_MS: '10000',
        RESEND_API_KEY: liveKeyShape,
        EMAIL_FROM: 'LunchLineup <no-reply@beta.lunchlineup.com>',
        APP_ORIGIN: 'https://beta.lunchlineup.com',
        ...overrides,
    }), (feedback ?? activeFeedback()) as any);
}

function activeFeedback() {
    return { isSuppressed: vi.fn().mockResolvedValue(false) };
}

function input(overrides: Partial<Parameters<SchedulePublishedEmailService['send']>[0]> = {}) {
    return {
        outboxId: 'outbox-1',
        recipientEmail: 'staff@example.test',
        title: 'Schedule published',
        body: 'Downtown: Jul 14, 2026 to Jul 20, 2026',
        ...overrides,
    };
}

function config(values: Record<string, string>): ConfigService {
    return {
        get: vi.fn((key: string, fallback?: unknown) => values[key] ?? fallback),
    } as unknown as ConfigService;
}
