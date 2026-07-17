import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { EmailDeliveryFeedbackController } from './email-delivery-feedback.controller';

describe('EmailDeliveryFeedbackController', () => {
    it('passes the captured raw body and signature headers to verification', async () => {
        const feedback = {
            handleProviderEvent: vi.fn().mockResolvedValue({ received: true }),
        };
        const controller = new EmailDeliveryFeedbackController(feedback as any);
        const rawBody = Buffer.from('{"type":"email.bounced"}');

        await expect(controller.handle(
            { rawBody } as any,
            'evt-1',
            '123',
            'v1,sig',
        )).resolves.toEqual({ received: true });
        expect(feedback.handleProviderEvent).toHaveBeenCalledWith(rawBody, {
            id: 'evt-1',
            timestamp: '123',
            signature: 'v1,sig',
        });
    });

    it('fails closed without the captured raw body', async () => {
        const controller = new EmailDeliveryFeedbackController({ handleProviderEvent: vi.fn() } as any);
        await expect(controller.handle({} as any, 'evt-1', '123', 'v1,sig'))
            .rejects.toBeInstanceOf(BadRequestException);
    });
});
