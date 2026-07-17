import { Body, Controller, Get, Headers, Param, Post, Put, Query, Req, SetMetadata } from '@nestjs/common';
import { normalizeLunchBreakGenerationIdempotencyKey } from './lunch-break-generation-idempotency';
import { normalizeShiftBreakUpdateIdempotencyKey } from './shift-break-update-idempotency';
import { normalizeSetupShiftsIdempotencyKey } from './setup-shifts-idempotency';
import {
    GenerateLunchBreaksRequest,
    LunchBreakPolicy,
    LunchBreaksService,
    PersistSetupShiftsRequest,
    UpdateShiftLunchBreaksRequest,
} from './lunch-breaks.service';

const Permission = (permission: string | string[]) => SetMetadata('permission', permission);

@Controller({ path: 'lunch-breaks', version: '1' })
export class LunchBreaksController {
    constructor(private readonly lunchBreaksService: LunchBreaksService) { }

    @Get()
    @Permission('lunch_breaks:read')
    async list(
        @Req() req: any,
        @Query('scheduleId') scheduleId?: string,
        @Query('locationId') locationId?: string,
        @Query('shiftIds') shiftIdsCsv?: string,
        @Query('startDate') startDate?: string,
        @Query('endDate') endDate?: string,
        @Query('limit') limit?: string,
        @Query('cursor') cursor?: string,
    ) {
        const shiftIds = shiftIdsCsv
            ? shiftIdsCsv.split(',').map((value) => value.trim()).filter(Boolean)
            : undefined;

        return this.lunchBreaksService.listLunchBreaks(req.user.tenantId, {
            scheduleId,
            locationId,
            shiftIds,
            startDate,
            endDate,
            limit,
            cursor,
        }, req.user);
    }

    @Get('policy')
    @Permission('lunch_breaks:read')
    async getPolicy(@Req() req: any) {
        return this.lunchBreaksService.getPolicy(req.user.tenantId);
    }

    @Put('policy')
    @Permission('lunch_breaks:write')
    async updatePolicy(@Req() req: any, @Body() body: Partial<LunchBreakPolicy>) {
        return this.lunchBreaksService.updatePolicy(req.user.tenantId, body ?? {});
    }

    @Post('generate')
    @Permission('lunch_breaks:write')
    async generate(
        @Req() req: any,
        @Body() body: GenerateLunchBreaksRequest,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const attemptKey = normalizeLunchBreakGenerationIdempotencyKey(idempotencyKey);
        return this.lunchBreaksService.generateLunchBreaks(req.user.tenantId, body ?? {}, attemptKey);
    }

    @Post('setup-shifts')
    @Permission(['lunch_breaks:write', 'shifts:write'])
    async persistSetupShifts(
        @Req() req: any,
        @Body() body: PersistSetupShiftsRequest,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const attemptKey = normalizeSetupShiftsIdempotencyKey(idempotencyKey);
        return this.lunchBreaksService.persistSetupShifts(req.user.tenantId, body ?? {}, attemptKey, req.user);
    }

    @Put('shift/:shiftId')
    @Permission('lunch_breaks:write')
    async updateShiftBreaks(
        @Req() req: any,
        @Param('shiftId') shiftId: string,
        @Body() body: UpdateShiftLunchBreaksRequest,
        @Headers('idempotency-key') idempotencyKey?: string,
    ) {
        const attemptKey = normalizeShiftBreakUpdateIdempotencyKey(idempotencyKey);
        return this.lunchBreaksService.updateShiftBreaks(req.user.tenantId, shiftId, body ?? {}, attemptKey, req.user);
    }
}
