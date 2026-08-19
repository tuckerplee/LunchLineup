import { Inject, Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
    type CreateEmailOptions,
    type CreateEmailResponse,
    Resend,
} from 'resend';
import { runtimeErrorText } from '../common/runtime-error-diagnostic';
import { EmailDeliveryFeedbackService } from './email-delivery-feedback.service';

const DEFAULT_PROVIDER_TIMEOUT_MS = 10_000;
const MIN_PROVIDER_TIMEOUT_MS = 1_000;
const MAX_PROVIDER_TIMEOUT_MS = 30_000;

type SchedulePublishedEmailInput = {
    outboxId: string;
    recipientEmail: string | null;
    title: string;
    body: string;
};

type AbortableEmailSend = (
    payload: CreateEmailOptions,
    options: { idempotencyKey: string; signal: AbortSignal },
) => Promise<CreateEmailResponse>;

export type SchedulePublishedEmailOutcome = 'accepted' | 'disabled' | 'not_addressable' | 'suppressed';

@Injectable()
export class SchedulePublishedEmailService {
    private readonly logger = new Logger(SchedulePublishedEmailService.name);
    private readonly enabled: boolean;
    private readonly resend: Resend | null;
    private readonly from: string;
    private readonly scheduleUrl: string;
    private readonly providerTimeoutMs: number;

    constructor(
        @Inject(ConfigService)
        private readonly configService: ConfigService,
        @Inject(EmailDeliveryFeedbackService)
        private readonly deliveryFeedback: EmailDeliveryFeedbackService,
    ) {
        this.enabled = this.canonicalBoolean('SCHEDULE_PUBLISHED_EMAIL_ENABLED', false);
        this.providerTimeoutMs = this.boundedInteger(
            'SCHEDULE_PUBLISHED_EMAIL_PROVIDER_TIMEOUT_MS',
            DEFAULT_PROVIDER_TIMEOUT_MS,
            MIN_PROVIDER_TIMEOUT_MS,
            MAX_PROVIDER_TIMEOUT_MS,
        );

        if (!this.enabled) {
            this.resend = null;
            this.from = '';
            this.scheduleUrl = '';
            return;
        }

        const apiKey = this.required('RESEND_API_KEY');
        if (!/^re_[A-Za-z0-9_-]{24,}$/.test(apiKey) || /^re_(?:dev|test)_/i.test(apiKey)) {
            throw new Error('RESEND_API_KEY must be a live Resend API key when schedule email delivery is enabled');
        }
        this.from = this.validSender(this.required('EMAIL_FROM'));
        this.scheduleUrl = `${this.httpsOrigin(this.required('APP_ORIGIN'))}/dashboard/scheduling`;
        this.resend = new Resend(apiKey);
    }

    async send(input: SchedulePublishedEmailInput): Promise<SchedulePublishedEmailOutcome> {
        if (!this.enabled) return 'disabled';
        const recipient = input.recipientEmail?.trim() ?? '';
        if (!this.validRecipient(recipient)) return 'not_addressable';
        const outboxId = this.providerIdentity(input.outboxId);
        const title = this.singleLineContent(input.title, 'schedule email title', 200);
        const body = this.boundedContent(input.body, 'schedule email body', 2_000);
        if (!this.resend) {
            throw new Error('Schedule publication email provider is not configured');
        }

        const htmlTitle = this.escapeHtml(title);
        const htmlBody = this.escapeHtml(body);
        const htmlScheduleUrl = this.escapeHtml(this.scheduleUrl);
        try {
            const outcome = await this.withDeadline(async (signal) => {
                if (await this.deliveryFeedback.isSuppressed(recipient)) {
                    this.logger.warn('Schedule publication email skipped reason=provider_feedback');
                    return 'suppressed' as const;
                }
                if (signal.aborted) throw signal.reason;

                const send = this.resend!.emails.send as unknown as AbortableEmailSend;
                const response = await send.call(this.resend!.emails, {
                    from: this.from,
                    to: recipient,
                    subject: title,
                    html: [
                        '<!doctype html><html><body style="font-family:system-ui,sans-serif;line-height:1.5;color:#172033">',
                        `<h1 style="font-size:22px">${htmlTitle}</h1>`,
                        `<p>${htmlBody}</p>`,
                        `<p><a href="${htmlScheduleUrl}">View your schedule in LunchLineup</a></p>`,
                        '<p>If you no longer work at this location, contact your manager.</p>',
                        '</body></html>',
                    ].join(''),
                    text: `${title}\n\n${body}\n\nView your schedule: ${this.scheduleUrl}\n\nIf you no longer work at this location, contact your manager.`,
                }, {
                    idempotencyKey: `schedule-published/${outboxId}`,
                    signal,
                });
                if (response.error) {
                    const providerError = new Error('Schedule publication email provider rejected delivery');
                    const statusCode = Number((response.error as { statusCode?: unknown }).statusCode);
                    if (Number.isInteger(statusCode) && statusCode >= 400 && statusCode <= 599) {
                        Object.defineProperty(providerError, 'status', { value: statusCode });
                    }
                    throw providerError;
                }
                if (
                    !response.data
                    || typeof response.data.id !== 'string'
                    || response.data.id.length < 1
                    || response.data.id.length > 255
                ) {
                    throw new Error('Schedule publication email provider returned an invalid response');
                }
                return 'accepted' as const;
            });
            if (outcome === 'accepted') {
                this.logger.log('Schedule publication email delivery accepted');
            }
            return outcome;
        } catch (error) {
            this.logger.error(`Schedule publication email delivery failed ${runtimeErrorText(error)}`);
            throw error;
        }
    }

    private canonicalBoolean(name: string, fallback: boolean): boolean {
        const configured = this.configService.get<string | boolean>(name);
        if (configured === undefined || configured === null || configured === '') return fallback;
        const normalized = String(configured).trim().toLowerCase();
        if (normalized === 'true') return true;
        if (normalized === 'false') return false;
        throw new Error(`${name} must be exactly true or false`);
    }

    private required(name: string): string {
        const value = String(this.configService.get(name) ?? '').trim();
        if (!value) throw new Error(`${name} is required when schedule email delivery is enabled`);
        if (/\r|\n/.test(value)) throw new Error(`${name} must be a single-line value`);
        return value;
    }

    private validSender(value: string): string {
        const match = value.match(/<([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)>$|^([^<>\s@]+@[^<>\s@]+\.[^<>\s@]+)$/);
        if (!match) throw new Error('EMAIL_FROM must contain a valid sender address');
        return value;
    }

    private httpsOrigin(value: string): string {
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error('APP_ORIGIN must be a canonical HTTPS origin for schedule email delivery');
        }
        if (
            parsed.protocol !== 'https:'
            || !parsed.hostname
            || parsed.username
            || parsed.password
            || parsed.pathname !== '/'
            || parsed.search
            || parsed.hash
        ) {
            throw new Error('APP_ORIGIN must be a canonical HTTPS origin for schedule email delivery');
        }
        return parsed.origin;
    }

    private validRecipient(value: string): boolean {
        return value.length >= 3
            && value.length <= 320
            && !/\r|\n/.test(value)
            && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
    }

    private providerIdentity(value: string): string {
        const normalized = String(value ?? '').trim();
        if (!/^[A-Za-z0-9-]{1,200}$/.test(normalized)) {
            throw new Error('Schedule publication email outbox identity is invalid');
        }
        return normalized;
    }

    private singleLineContent(value: string, label: string, maximum: number): string {
        const normalized = String(value ?? '').trim();
        if (!normalized || normalized.length > maximum || /\r|\n/.test(normalized)) {
            throw new Error(`${label} is invalid`);
        }
        return normalized;
    }

    private boundedContent(value: string, label: string, maximum: number): string {
        const normalized = String(value ?? '').trim();
        if (!normalized || normalized.length > maximum || normalized.includes('\0')) {
            throw new Error(`${label} is invalid`);
        }
        return normalized;
    }

    private boundedInteger(name: string, fallback: number, minimum: number, maximum: number): number {
        const configured = this.configService.get<string | number>(name);
        const parsed = Number(configured ?? fallback);
        if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
            throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
        }
        return parsed;
    }

    private async withDeadline<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
        const deadlineError = new Error('Schedule publication email provider deadline exceeded');
        const controller = new AbortController();
        let timeout: NodeJS.Timeout | undefined;
        try {
            return await Promise.race([
                operation(controller.signal),
                new Promise<never>((_resolve, reject) => {
                    timeout = setTimeout(() => {
                        controller.abort(deadlineError);
                        reject(deadlineError);
                    }, this.providerTimeoutMs);
                }),
            ]);
        } finally {
            if (timeout) clearTimeout(timeout);
        }
    }

    private escapeHtml(value: string): string {
        return value.replace(/[&<>"']/g, (character) => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        })[character] ?? character);
    }
}
