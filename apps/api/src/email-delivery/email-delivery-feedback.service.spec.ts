import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryFeedbackService } from './email-delivery-feedback.service';

function config(values: Record<string, string> = {}) {
    return { get: vi.fn((key: string) => values[key]) };
}

describe('EmailDeliveryFeedbackService', () => {
    it('does not break local startup without Resend and fails closed if feedback is invoked', async () => {
        const service = new EmailDeliveryFeedbackService(config({}) as any, {
            withPlatformAdmin: vi.fn(),
        } as any);

        await expect(service.handleProviderEvent(
            Buffer.from('{}'),
            { id: 'evt-1', timestamp: '123', signature: 'v1,sig' },
        )).rejects.toThrow('Resend delivery feedback is not configured');
    });

    it('verifies permanent provider feedback and updates matching active users without storing recipient text', async () => {
        const updateMany = vi.fn().mockResolvedValue({ count: 2 });
        const tenantDb = {
            withPlatformAdmin: vi.fn(async (operation: any) => operation({
                user: { updateMany, findFirst: vi.fn() },
            })),
        };
        const service = new EmailDeliveryFeedbackService(config({
            RESEND_API_KEY: 're_test',
            RESEND_WEBHOOK_SECRET: 'whsec_test',
        }) as any, tenantDb as any);
        (service as any).resend = {
            webhooks: {
                verify: vi.fn().mockReturnValue({
                    type: 'email.bounced',
                    created_at: '2026-07-14T16:00:00.000Z',
                    data: {
                        to: ['Owner@Example.com', 'owner@example.com'],
                        bounce: { type: 'Permanent' },
                    },
                }),
            },
        };

        await expect(service.handleProviderEvent(
            Buffer.from('{"signed":true}'),
            { id: 'evt-1', timestamp: '123', signature: 'v1,sig' },
        )).resolves.toEqual({ received: true, suppressed: true, matchedUsers: 2 });

        expect(updateMany).toHaveBeenCalledOnce();
        expect(updateMany).toHaveBeenCalledWith({
            where: expect.objectContaining({
                deletedAt: null,
                email: { equals: 'owner@example.com', mode: 'insensitive' },
            }),
            data: {
                emailDeliverySuppressedAt: new Date('2026-07-14T16:00:00.000Z'),
                emailDeliverySuppressionReason: 'hard_bounce',
                emailDeliveryLastEventAt: new Date('2026-07-14T16:00:00.000Z'),
            },
        });
        expect(JSON.stringify(updateMany.mock.calls)).not.toContain('signed');
    });

    it('ignores transient bounces and rejects invalid signatures', async () => {
        const tenantDb = { withPlatformAdmin: vi.fn() };
        const service = new EmailDeliveryFeedbackService(config({
            RESEND_API_KEY: 're_test',
            RESEND_WEBHOOK_SECRET: 'whsec_test',
        }) as any, tenantDb as any);
        const verify = vi.fn().mockReturnValue({
            type: 'email.bounced',
            created_at: '2026-07-14T16:00:00.000Z',
            data: { to: ['owner@example.com'], bounce: { type: 'Transient' } },
        });
        (service as any).resend = { webhooks: { verify } };

        await expect(service.handleProviderEvent(
            Buffer.from('transient'),
            { id: 'evt-2', timestamp: '123', signature: 'v1,sig' },
        )).resolves.toEqual({ received: true, suppressed: false, matchedUsers: 0 });
        expect(tenantDb.withPlatformAdmin).not.toHaveBeenCalled();

        verify.mockImplementation(() => { throw new Error('contains owner@example.com'); });
        await expect(service.handleProviderEvent(
            Buffer.from('invalid'),
            { id: 'evt-3', timestamp: '123', signature: 'bad' },
        )).rejects.toBeInstanceOf(BadRequestException);
    });

    it('blocks only active users with provider suppression state', async () => {
        const findFirst = vi.fn().mockResolvedValue({ id: 'user-1' });
        const service = new EmailDeliveryFeedbackService(config({ RESEND_API_KEY: 're_test' }) as any, {
            withPlatformAdmin: vi.fn(async (operation: any) => operation({ user: { findFirst } })),
        } as any);

        await expect(service.isSuppressed(' Owner@Example.com ')).resolves.toBe(true);
        expect(findFirst).toHaveBeenCalledWith({
            where: {
                deletedAt: null,
                email: { equals: 'owner@example.com', mode: 'insensitive' },
                emailDeliverySuppressedAt: { not: null },
            },
            select: { id: true },
        });
    });
});
