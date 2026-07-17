import {
    BadRequestException,
    Controller,
    Headers,
    HttpCode,
    Post,
    Req,
    SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import { EmailDeliveryFeedbackService } from './email-delivery-feedback.service';

const Public = () => SetMetadata('isPublic', true);
type RawBodyRequest = Request & { rawBody?: Buffer };

@Controller({ path: 'email-delivery/provider-events', version: '1' })
export class EmailDeliveryFeedbackController {
    constructor(private readonly feedback: EmailDeliveryFeedbackService) {}

    @Post()
    @Public()
    @HttpCode(200)
    async handle(
        @Req() req: RawBodyRequest,
        @Headers('svix-id') id?: string,
        @Headers('svix-timestamp') timestamp?: string,
        @Headers('svix-signature') signature?: string,
    ) {
        if (!Buffer.isBuffer(req.rawBody)) {
            throw new BadRequestException('Missing raw Resend webhook body');
        }
        return this.feedback.handleProviderEvent(req.rawBody, { id, timestamp, signature });
    }
}
