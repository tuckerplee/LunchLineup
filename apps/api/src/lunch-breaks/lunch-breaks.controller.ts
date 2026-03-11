import { Body, Controller, Get, Param, Post, Put, Query, Req, SetMetadata } from '@nestjs/common';
import {
    GenerateLunchBreaksRequest,
    LunchBreakPolicy,
    LunchBreaksService,
    PersistSetupShiftsRequest,
    UpdateShiftLunchBreaksRequest,
} from './lunch-breaks.service';

const Permission = (perm: string) => SetMetadata('permission', perm);

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
        });
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
    async generate(@Req() req: any, @Body() body: GenerateLunchBreaksRequest) {
        return this.lunchBreaksService.generateLunchBreaks(req.user.tenantId, body ?? {});
    }

    @Post('setup-shifts')
    @Permission('lunch_breaks:write')
    async persistSetupShifts(@Req() req: any, @Body() body: PersistSetupShiftsRequest) {
        return this.lunchBreaksService.persistSetupShifts(req.user.tenantId, body ?? {});
    }

    @Put('shift/:shiftId')
    @Permission('lunch_breaks:write')
    async updateShiftBreaks(
        @Req() req: any,
        @Param('shiftId') shiftId: string,
        @Body() body: UpdateShiftLunchBreaksRequest,
    ) {
        return this.lunchBreaksService.updateShiftBreaks(req.user.tenantId, shiftId, body ?? {});
    }
}
