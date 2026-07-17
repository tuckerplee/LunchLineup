import {
    BadRequestException,
    Body,
    Controller,
    Get,
    HttpCode,
    HttpStatus,
    Param,
    Post,
    Req,
    UploadedFile,
    UseInterceptors,
} from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';

import { RequirePermission } from '../auth/require-permission.decorator';
import {
    AvailabilityImportsService,
    MAX_AVAILABILITY_PDF_BYTES,
    UploadedAvailabilityPdf,
} from './availability-imports.service';

type AuthenticatedRequest = {
    user: { sub: string; tenantId: string };
    headers: Record<string, string | string[] | undefined>;
};

@Controller({ path: 'availability-imports', version: '1' })
export class AvailabilityImportsController {
    constructor(private readonly imports: AvailabilityImportsService) {}

    @Post('users/:userId')
    @HttpCode(HttpStatus.ACCEPTED)
    @RequirePermission('users:write')
    @UseInterceptors(FileInterceptor('file', {
        limits: {
            fileSize: MAX_AVAILABILITY_PDF_BYTES,
            files: 1,
            fields: 1,
            fieldSize: 256,
            parts: 2,
        },
    }))
    async create(
        @Req() req: AuthenticatedRequest,
        @Param('userId') userId: string,
        @UploadedFile() file?: UploadedAvailabilityPdf,
        @Body('staffIdentity') staffIdentity?: string,
    ) {
        const idempotencyKey = this.header(req, 'idempotency-key');
        if (!idempotencyKey) {
            throw new BadRequestException('Idempotency-Key is required.');
        }
        return this.imports.createImport({
            tenantId: req.user.tenantId,
            requestedByUserId: req.user.sub,
            userId,
            idempotencyKey,
            staffIdentity,
            file,
        });
    }

    @Get(':id')
    @RequirePermission('users:write')
    get(@Req() req: AuthenticatedRequest, @Param('id') id: string) {
        return this.imports.getImport(req.user.tenantId, id);
    }

    private header(req: AuthenticatedRequest, name: string): string | undefined {
        const value = req.headers[name];
        return Array.isArray(value) ? value[0] : value;
    }
}
