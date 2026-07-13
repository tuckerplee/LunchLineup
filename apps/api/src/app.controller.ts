import { Controller, Get, HttpStatus, Res, VERSION_NEUTRAL, SetMetadata } from '@nestjs/common';
import { Response } from 'express';
import { HealthService } from './common/health.service';

const Public = () => SetMetadata('isPublic', true);

@Controller({ version: VERSION_NEUTRAL })
export class AppController {
    constructor(private readonly healthService: HealthService) { }

    @Public()
    @Get('health')
    async checkHealth(@Res({ passthrough: true }) res: Response) {
        const health = await this.healthService.check();
        if (health.status !== 'ok') {
            res.status(HttpStatus.SERVICE_UNAVAILABLE);
        }
        return health;
    }
}
