import {
    BadRequestException,
    Injectable,
    Logger,
    Optional,
    ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import crypto from 'crypto';
import { Resend } from 'resend';
import { TenantPrismaService } from '../database/tenant-prisma.service';

export type ResendWebhookHeaders = {
    id?: string;
    timestamp?: string;
    signature?: string;
};

type VerifiedEmailEvent = {
    type: string;
    created_at: string;
    data?: {
        to?: unknown;
        bounce?: { type?: unknown };
    };
};

type SuppressionDisposition = {
    reason: 'hard_bounce' | 'complaint' | 'provider_suppressed';
    recipients: string[];
    occurredAt: Date;
};

@Injectable()
export class EmailDeliveryFeedbackService {
    private readonly logger = new Logger(EmailDeliveryFeedbackService.name);
    private readonly tenantDb: TenantPrismaService;
    private readonly resend: Resend | null;

    constructor(
        private readonly configService: ConfigService,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
        const apiKey = String(this.configService.get('RESEND_API_KEY') ?? '').trim();
        this.resend = apiKey ? new Resend(apiKey) : null;
    }

    async handleProviderEvent(payload: Buffer, headers: ResendWebhookHeaders) {
        const webhookSecret = String(this.configService.get('RESEND_WEBHOOK_SECRET') ?? '').trim();
        if (!webhookSecret || !this.resend) {
            throw new ServiceUnavailableException('Resend delivery feedback is not configured');
        }
        if (!headers.id || !headers.timestamp || !headers.signature) {
            throw new BadRequestException('Missing Resend webhook signature headers');
        }

        let event: VerifiedEmailEvent;
        try {
            event = this.resend.webhooks.verify({
                payload: payload.toString('utf8'),
                headers: {
                    id: headers.id,
                    timestamp: headers.timestamp,
                    signature: headers.signature,
                },
                webhookSecret,
            }) as VerifiedEmailEvent;
        } catch {
            this.logger.warn(`Rejected invalid Resend webhook event_ref=${this.eventRef(headers.id)}`);
            throw new BadRequestException('Invalid Resend webhook signature');
        }

        const disposition = this.suppressionDisposition(event);
        if (!disposition) {
            return { received: true, suppressed: false, matchedUsers: 0 };
        }

        const matchedUsers = await this.tenantDb.withPlatformAdmin(async (tx) => {
            let matched = 0;
            for (const recipient of disposition.recipients) {
                const updated = await tx.user.updateMany({
                    where: {
                        deletedAt: null,
                        email: { equals: recipient, mode: 'insensitive' },
                        OR: [
                            { emailDeliveryLastEventAt: null },
                            { emailDeliveryLastEventAt: { lte: disposition.occurredAt } },
                        ],
                    },
                    data: {
                        emailDeliverySuppressedAt: disposition.occurredAt,
                        emailDeliverySuppressionReason: disposition.reason,
                        emailDeliveryLastEventAt: disposition.occurredAt,
                    },
                });
                matched += updated.count;
            }
            return matched;
        });

        this.logger.warn(
            `Resend recipient suppression applied type=${event.type} recipients=${disposition.recipients.length} matched_users=${matchedUsers}`,
        );
        return { received: true, suppressed: true, matchedUsers };
    }

    async isSuppressed(email: string): Promise<boolean> {
        const normalized = this.normalizeRecipient(email);
        if (!normalized) {
            return true;
        }
        const user = await this.tenantDb.withPlatformAdmin((tx) => tx.user.findFirst({
            where: {
                deletedAt: null,
                email: { equals: normalized, mode: 'insensitive' },
                emailDeliverySuppressedAt: { not: null },
            },
            select: { id: true },
        }));
        return Boolean(user);
    }

    private suppressionDisposition(event: VerifiedEmailEvent): SuppressionDisposition | null {
        let reason: SuppressionDisposition['reason'] | null = null;
        if (event.type === 'email.complained') {
            reason = 'complaint';
        } else if (event.type === 'email.suppressed') {
            reason = 'provider_suppressed';
        } else if (event.type === 'email.bounced') {
            const bounceType = String(event.data?.bounce?.type ?? '').toLowerCase();
            if (bounceType.includes('hard') || bounceType.includes('permanent')) {
                reason = 'hard_bounce';
            }
        }
        if (!reason) {
            return null;
        }

        const occurredAt = new Date(event.created_at);
        if (!Number.isFinite(occurredAt.getTime())) {
            throw new BadRequestException('Invalid Resend webhook timestamp');
        }
        const rawRecipients = Array.isArray(event.data?.to) ? event.data.to : [];
        const recipients = Array.from(new Set(
            rawRecipients
                .map((value) => this.normalizeRecipient(value))
                .filter((value): value is string => Boolean(value)),
        ));
        if (recipients.length === 0) {
            return null;
        }
        return { reason, recipients, occurredAt };
    }

    private normalizeRecipient(value: unknown): string | null {
        if (typeof value !== 'string') return null;
        const normalized = value.trim().toLowerCase();
        if (normalized.length < 3 || normalized.length > 320 || !normalized.includes('@')) return null;
        return normalized;
    }

    private eventRef(id: string): string {
        return crypto.createHash('sha256').update(id).digest('hex').slice(0, 12);
    }
}
