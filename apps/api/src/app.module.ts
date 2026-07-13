import { Module, NestModule, MiddlewareConsumer } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { ThrottlerModule } from '@nestjs/throttler';
import { APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';

// Auth
import { AuthModule } from './auth/auth.module';
import { JwtAuthGuard } from './auth/jwt-auth.guard';
import { RbacGuard } from './auth/rbac.guard';

// Controllers
import { AppController } from './app.controller';
import { LocationsController } from './locations/locations.controller';
import { ShiftsController } from './shifts/shifts.controller';
import { SchedulesController } from './schedules/schedules.controller';
import { UsersController } from './users/users.controller';
import { TimeCardsController } from './time-cards/time-cards.controller';
import { MetricsController } from './common/metrics.controller';
import { AdminController } from './admin/admin.controller';
import { SettingsController } from './settings/settings.controller';

// Guards
import { RateLimitsGuard } from './common/guards/rate-limits.guard';

// Services & Modules
import { WebhooksModule } from './webhooks/webhooks.module';
import { BillingModule } from './billing/billing.module';
import { NotificationsModule } from './notifications/notifications.module';
import { LunchBreaksModule } from './lunch-breaks/lunch-breaks.module';
import { MetricsService } from './common/metrics.service';
import { MetricsInterceptor } from './common/metrics.interceptor';
import { HealthService } from './common/health.service';
import { CorrelationIdMiddleware } from './middleware/correlation-id.middleware';
import { TenantPrismaService } from './database/tenant-prisma.service';

@Module({
    imports: [
        ConfigModule.forRoot({ isGlobal: true }),
        ThrottlerModule.forRoot([
            { name: 'default', ttl: 60000, limit: 100 },       // 100 req/min global
            { name: 'auth', ttl: 900000, limit: 5 },             // 5 auth attempts per 15 min
            { name: 'authIp', ttl: 900000, limit: 30 },           // NAT-safe pre-auth ceiling per endpoint
            { name: 'authIdentifier', ttl: 900000, limit: 5 },    // 5 pre-auth attempts per account and endpoint
            { name: 'refreshIp', ttl: 900000, limit: 100 },        // Shared office NAT ceiling for refresh
            { name: 'refreshCredential', ttl: 900000, limit: 5 }, // Per-refresh-credential abuse ceiling
            { name: 'expensive', ttl: 60000, limit: 10 },        // 10 expensive ops/min
        ]),
        AuthModule,
        WebhooksModule,
        BillingModule,
        NotificationsModule,
        LunchBreaksModule,
    ],
    controllers: [
        AppController,
        LocationsController,
        ShiftsController,
        SchedulesController,
        UsersController,
        TimeCardsController,
        MetricsController,
        AdminController,
        SettingsController,
    ],
    providers: [
        // Global guards (default deny)
        { provide: APP_GUARD, useClass: JwtAuthGuard },
        { provide: APP_GUARD, useClass: RbacGuard },
        { provide: APP_GUARD, useClass: RateLimitsGuard },
        { provide: APP_INTERCEPTOR, useClass: MetricsInterceptor },
        HealthService,
        MetricsService,
        TenantPrismaService,
    ],
})
export class AppModule implements NestModule {
    configure(consumer: MiddlewareConsumer) {
        consumer.apply(CorrelationIdMiddleware).forRoutes('*');
    }
}
