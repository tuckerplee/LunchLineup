import { Controller, Get, VERSION_NEUTRAL, SetMetadata } from '@nestjs/common';

const Public = () => SetMetadata('isPublic', true);

@Controller({ version: VERSION_NEUTRAL })
export class AppController {
    @Public()
    @Get('health')
    checkHealth() {
        return { status: 'ok', timestamp: new Date().toISOString() };
    }
}
