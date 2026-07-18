import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, MODULE_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { APP_GUARD } from '@nestjs/core';
import { readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';
import { AdminController } from '../admin/admin.controller';
import { AppController } from '../app.controller';
import { AppModule } from '../app.module';
import { AvailabilityImportsController } from '../availability-imports/availability-imports.controller';
import { BillingController } from '../billing/billing.controller';
import { MetricsController } from '../common/metrics.controller';
import { RateLimitsGuard } from '../common/guards/rate-limits.guard';
import { EmailDeliveryFeedbackController } from '../email-delivery/email-delivery-feedback.controller';
import { LocationsController } from '../locations/locations.controller';
import { LunchBreaksController } from '../lunch-breaks/lunch-breaks.controller';
import { NotificationsController } from '../notifications/notifications.controller';
import { PayrollController } from '../payroll/payroll.controller';
import { PayrollModule } from '../payroll/payroll.module';
import { SchedulesController } from '../schedules/schedules.controller';
import { SettingsController } from '../settings/settings.controller';
import { ShiftsController } from '../shifts/shifts.controller';
import { TimeCardsController } from '../time-cards/time-cards.controller';
import { UsersController } from '../users/users.controller';
import { WebhookEndpointsController } from '../webhooks/webhook-endpoints.controller';
import { AuthController } from './auth.controller';
import { JwtAuthGuard } from './jwt-auth.guard';
import { RbacGuard } from './rbac.guard';
import { ALLOW_AUTHENTICATED_METADATA_KEY, PERMISSION_METADATA_KEY } from './require-permission.decorator';

type ControllerType = {
    name: string;
    prototype: Record<string, unknown>;
};

type AuditedRoute = {
    controller: ControllerType;
    controllerName: string;
    handler: (...args: unknown[]) => unknown;
    handlerName: string;
    method: RequestMethod;
    path: string;
};

const AUDITED_CONTROLLERS = [
    AppController,
    MetricsController,
    BillingController,
    EmailDeliveryFeedbackController,
    AvailabilityImportsController,
    SchedulesController,
    ShiftsController,
    LunchBreaksController,
    TimeCardsController,
    UsersController,
    LocationsController,
    SettingsController,
    NotificationsController,
    PayrollController,
    WebhookEndpointsController,
    AuthController,
    AdminController,
] as unknown as ControllerType[];

const EXPECTED_CONTROLLER_FILES = [
    'admin/admin.controller.ts',
    'app.controller.ts',
    'auth/auth.controller.ts',
    'availability-imports/availability-imports.controller.ts',
    'billing/billing.controller.ts',
    'common/metrics.controller.ts',
    'email-delivery/email-delivery-feedback.controller.ts',
    'locations/locations.controller.ts',
    'lunch-breaks/lunch-breaks.controller.ts',
    'notifications/notifications.controller.ts',
    'payroll/payroll.controller.ts',
    'schedules/schedules.controller.ts',
    'settings/settings.controller.ts',
    'shifts/shifts.controller.ts',
    'time-cards/time-cards.controller.ts',
    'users/users.controller.ts',
    'webhooks/webhook-endpoints.controller.ts',
];

const EXPECTED_ROUTE_COUNTS: Record<string, number> = {
    AppController: 2,
    MetricsController: 1,
    BillingController: 11,
    EmailDeliveryFeedbackController: 1,
    AvailabilityImportsController: 2,
    SchedulesController: 11,
    ShiftsController: 7,
    LunchBreaksController: 6,
    TimeCardsController: 6,
    UsersController: 18,
    LocationsController: 6,
    SettingsController: 4,
    NotificationsController: 3,
    PayrollController: 17,
    WebhookEndpointsController: 5,
    AuthController: 20,
    AdminController: 34,
};

const EXPECTED_PUBLIC_ROUTES = [
    'AppController.checkHealth',
    'AppController.checkLiveness',
    'AuthController.callback',
    'AuthController.confirmPasswordReset',
    'AuthController.login',
    'AuthController.logout',
    'AuthController.refresh',
    'AuthController.requestPasswordReset',
    'AuthController.resolveLoginFlow',
    'AuthController.sendOtp',
    'AuthController.verifyOtp',
    'AuthController.verifyPassword',
    'AuthController.verifyPin',
    'BillingController.handleStripeMeterErrorWebhook',
    'BillingController.handleStripeWebhook',
    'EmailDeliveryFeedbackController.handle',
    'MetricsController.getMetrics',
];

const EXPECTED_AUTHENTICATED_ONLY_ROUTES = [
    'AuthController.beginMfaEnrollment',
    'AuthController.beginMfaEnrollmentAlias',
    'AuthController.confirmMfaEnrollment',
    'AuthController.confirmMfaEnrollmentAlias',
    'AuthController.disableMfa',
    'AuthController.disableMfaAlias',
    'AuthController.getMfaEnrollment',
    'AuthController.me',
    'AuthController.verifyMfa',
    'UsersController.rotateOwnPin',
];

function effectiveMetadata<T>(route: AuditedRoute, key: string): T | undefined {
    const handlerValue = Reflect.getMetadata(key, route.handler) as T | undefined;
    return handlerValue !== undefined
        ? handlerValue
        : Reflect.getMetadata(key, route.controller) as T | undefined;
}

function routeInventory(): AuditedRoute[] {
    return AUDITED_CONTROLLERS.flatMap((controller) => {
        const controllerPath = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
        return Object.getOwnPropertyNames(controller.prototype).flatMap((handlerName) => {
            if (handlerName === 'constructor') return [];
            const handler = controller.prototype[handlerName];
            if (typeof handler !== 'function') return [];
            const method = Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod | undefined;
            if (method === undefined) return [];
            const routePath = String(Reflect.getMetadata(PATH_METADATA, handler) ?? '');
            return [{
                controller,
                controllerName: controller.name.replace(/\d+$/, ''),
                handler: handler as (...args: unknown[]) => unknown,
                handlerName,
                method,
                path: [controllerPath, routePath].filter(Boolean).join('/'),
            }];
        });
    });
}

function controllerFileInventory(root: string, directory = root): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) return controllerFileInventory(root, path);
        return entry.isFile() && entry.name.endsWith('.controller.ts')
            ? [relative(root, path).split(sep).join('/')]
            : [];
    });
}

describe('externally reachable API authorization inventory', () => {
    const routes = routeInventory();

    it('keeps the complete controller route inventory explicit', () => {
        const sourceRoot = join(__dirname, '..');
        expect(controllerFileInventory(sourceRoot).sort()).toEqual([...EXPECTED_CONTROLLER_FILES].sort());

        const counts = Object.fromEntries(AUDITED_CONTROLLERS.map((controller) => [
            controller.name.replace(/\d+$/, ''),
            routes.filter((route) => route.controller === controller).length,
        ]));
        expect(counts).toEqual(EXPECTED_ROUTE_COUNTS);
        expect(routes).toHaveLength(154);
    });

    it('keeps authentication, authorization, and abuse controls registered globally', () => {
        const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, AppModule) as unknown[];
        const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, AppModule) as Array<{
            provide?: unknown;
            useClass?: unknown;
        }>;
        const globalGuards = providers
            .filter((provider) => provider?.provide === APP_GUARD)
            .map((provider) => provider.useClass);

        expect(globalGuards).toEqual(expect.arrayContaining([
            JwtAuthGuard,
            RbacGuard,
            RateLimitsGuard,
        ]));
        expect(imports).toContain(PayrollModule);
    });

    it('requires one explicit effective authorization decision for every audited route', () => {
        const failures = routes.flatMap((route) => {
            const permission = effectiveMetadata<string | string[]>(route, PERMISSION_METADATA_KEY);
            const allowAuthenticated = effectiveMetadata<boolean>(route, ALLOW_AUTHENTICATED_METADATA_KEY) === true;
            const isPublic = effectiveMetadata<boolean>(route, 'isPublic') === true;
            const hasPermission = Array.isArray(permission)
                ? permission.length > 0 && permission.every((value) => typeof value === 'string' && value.trim().length > 0)
                : typeof permission === 'string' && permission.trim().length > 0;
            const decisions = [hasPermission, allowAuthenticated, isPublic].filter(Boolean).length;
            return decisions === 1
                ? []
                : [`${route.controllerName}.${route.handlerName} ${route.path} has ${decisions} authorization decisions`];
        });

        expect(failures).toEqual([]);
    });

    it('limits public and session-only exceptions to the reviewed allowlists', () => {
        const publicRoutes = routes
            .filter((route) => effectiveMetadata<boolean>(route, 'isPublic') === true)
            .map((route) => `${route.controllerName}.${route.handlerName}`)
            .sort();
        const authenticatedOnlyRoutes = routes
            .filter((route) => effectiveMetadata<boolean>(route, ALLOW_AUTHENTICATED_METADATA_KEY) === true)
            .map((route) => `${route.controllerName}.${route.handlerName}`)
            .sort();

        expect(publicRoutes).toEqual([...EXPECTED_PUBLIC_ROUTES].sort());
        expect(authenticatedOnlyRoutes).toEqual([...EXPECTED_AUTHENTICATED_ONLY_ROUTES].sort());
    });

    it('keeps planner inputs and solve snapshots behind schedule write access', () => {
        expect(Reflect.getMetadata(
            PERMISSION_METADATA_KEY,
            SchedulesController.prototype.findDemandWindows,
        )).toBe('schedules:write');
        expect(Reflect.getMetadata(
            PERMISSION_METADATA_KEY,
            SchedulesController.prototype.findAutoScheduleJob,
        )).toBe('schedules:write');
    });

    it('keeps live subscription recovery reads behind billing read access', () => {
        expect(Reflect.getMetadata(
            PERMISSION_METADATA_KEY,
            BillingController.prototype.subscriptionRecoveryAction,
        )).toBe('billing:read');
    });

    it('keeps every payroll route bound to its exact reviewed permission', () => {
        const expected = {
            exportEntitlement: 'payroll:export',
            listPolicies: 'payroll:read',
            getPolicy: 'payroll:read',
            createPolicy: 'payroll:policy_write',
            listPeriods: 'payroll:read',
            createPeriod: 'payroll:policy_write',
            getPeriod: 'payroll:read',
            adoptCards: 'payroll:policy_write',
            startReview: 'payroll:lock',
            decideCards: 'time_cards:approve',
            lockPeriod: 'payroll:lock',
            createAmendment: 'payroll:reconcile',
            decideAmendment: 'time_cards:approve',
            createExport: 'payroll:export',
            downloadExport: 'payroll:export',
            getExport: 'payroll:read',
            reconcileExport: 'payroll:reconcile',
        };

        for (const [handlerName, permission] of Object.entries(expected)) {
            const handler = PayrollController.prototype[handlerName as keyof typeof PayrollController.prototype];
            expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission);
            expect(Reflect.getMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, handler)).toBeUndefined();
            expect(Reflect.getMetadata('isPublic', handler)).toBeUndefined();
        }
    });

    it('keeps tenant account self-service scoped below platform admin access', () => {
        const expected = {
            exportOwnTenant: 'account:data_export',
            listOwnTenantExports: 'account:data_export',
            getOwnTenantExport: 'account:data_export',
            downloadOwnTenantExport: 'account:data_export',
            getOwnTenantAccountStatus: 'settings:write',
            cancelOwnTenant: 'tenant_account:lifecycle',
            requestOwnTenantDeletion: 'tenant_account:lifecycle',
        };

        for (const [handlerName, permission] of Object.entries(expected)) {
            const handler = AdminController.prototype[handlerName as keyof typeof AdminController.prototype];
            expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, handler)).toBe(permission);
        }
        expect(Reflect.getMetadata(PERMISSION_METADATA_KEY, AdminController)).toBe('admin_portal:access');
    });
});
