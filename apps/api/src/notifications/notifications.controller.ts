import { Body, Controller, Get, Post, Query, Req, SetMetadata } from '@nestjs/common';
import { NotificationsService } from './notifications.service';

const Permission = (perm: string) => SetMetadata('permission', perm);

@Controller({ path: 'notifications', version: '1' })
export class NotificationsController {
    constructor(private readonly notificationsService: NotificationsService) { }

    @Get()
    @Permission('notifications:read')
    async list(
        @Req() req: any,
        @Query('status') status?: 'all' | 'unread',
        @Query('limit') limit?: string,
    ) {
        const unreadOnly = status === 'unread';
        const parsedLimit = Number.parseInt(limit ?? '20', 10);
        const feed = await this.notificationsService.getFeed(req.user.tenantId, req.user.sub, {
            unreadOnly,
            limit: Number.isNaN(parsedLimit) ? 20 : parsedLimit,
        });

        return {
            data: feed.notifications,
            unreadCount: feed.unreadCount,
        };
    }

    @Post('read')
    @Permission('notifications:write')
    async markRead(@Req() req: any, @Body() body: { ids?: string[] }) {
        const ids = Array.isArray(body?.ids) ? body.ids.filter((id) => typeof id === 'string' && id.length > 0) : [];
        const result = await this.notificationsService.markAsRead(ids, req.user.tenantId, req.user.sub);
        const unreadCount = await this.notificationsService.getUnreadCount(req.user.tenantId, req.user.sub);
        return { ...result, unreadCount };
    }

    @Post('read-all')
    @Permission('notifications:write')
    async markAllRead(@Req() req: any) {
        await this.notificationsService.markAllAsRead(req.user.tenantId, req.user.sub);
        return { success: true, unreadCount: 0 };
    }
}
