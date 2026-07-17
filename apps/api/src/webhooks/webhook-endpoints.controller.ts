import {
    BadRequestException,
    Body,
    Controller,
    Delete,
    ForbiddenException,
    Get,
    HttpCode,
    HttpStatus,
    NotFoundException,
    Optional,
    Param,
    Post,
    Put,
    Req,
    UseGuards,
} from '@nestjs/common';
import crypto from 'crypto';
import { JwtAuthGuard } from '../auth/jwt-auth.guard';
import { RbacGuard } from '../auth/rbac.guard';
import { RequirePermission } from '../auth/require-permission.decorator';
import { FeatureAccessService } from '../billing/feature-access.service';
import { TenantPrismaService } from '../database/tenant-prisma.service';
import { WebhookDeliveryCrypto } from './webhook-delivery.crypto';
import { WEBHOOK_EVENT_TYPES, type WebhookEventType } from './webhooks.service';

const MAX_ENDPOINTS_PER_TENANT = 10;
const MAX_AUDIT_URL_LENGTH = 512;
const MAX_AUDIT_IP_LENGTH = 128;
const MAX_AUDIT_USER_AGENT_LENGTH = 512;

const WEBHOOK_ENDPOINT_AUDIT = {
    created: 'WEBHOOK_ENDPOINT_CREATED',
    updated: 'WEBHOOK_ENDPOINT_UPDATED',
    secretRotated: 'WEBHOOK_ENDPOINT_SECRET_ROTATED',
    deactivated: 'WEBHOOK_ENDPOINT_DEACTIVATED',
} as const;

type EndpointAuditSource = {
    id: string;
    url: string;
    events: unknown[];
    active: boolean;
};

type EndpointMutationBody = {
    url?: unknown;
    events?: unknown;
    active?: unknown;
};

@Controller({ path: 'webhooks/endpoints', version: '1' })
@UseGuards(JwtAuthGuard, RbacGuard)
export class WebhookEndpointsController {
    private readonly tenantDb: TenantPrismaService;

    constructor(
        private readonly featureAccessService: FeatureAccessService,
        private readonly deliveryCrypto: WebhookDeliveryCrypto,
        @Optional() tenantDb?: TenantPrismaService,
    ) {
        this.tenantDb = tenantDb ?? new TenantPrismaService();
    }

    @Get()
    @RequirePermission('settings:read')
    async list(@Req() req: any) {
        const tenantId = req.user.tenantId;
        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'webhooks');
            return tx.webhookEndpoint.findMany({
                where: { tenantId },
                select: this.publicEndpointSelect(),
                orderBy: { createdAt: 'asc' },
            });
        });
    }

    @Post()
    @RequirePermission('settings:write')
    async create(@Body() body: EndpointMutationBody, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const url = this.parseUrl(body?.url);
        const events = this.parseEvents(body?.events);
        const secret = this.generateSecret();

        const endpoint = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'webhooks');
            const endpointCount = await tx.webhookEndpoint.count({ where: { tenantId } });
            if (endpointCount >= MAX_ENDPOINTS_PER_TENANT) {
                throw new BadRequestException(`A tenant may configure at most ${MAX_ENDPOINTS_PER_TENANT} webhook endpoints`);
            }

            const created = await tx.webhookEndpoint.create({
                data: {
                    tenantId,
                    url,
                    events,
                    secret: this.deliveryCrypto.encryptString(secret),
                    active: true,
                },
                select: this.publicEndpointSelect(),
            });
            await tx.auditLog.create({
                data: {
                    ...this.auditAttribution(req, tenantId),
                    action: WEBHOOK_ENDPOINT_AUDIT.created,
                    resource: 'WebhookEndpoint',
                    resourceId: created.id,
                    newValue: this.endpointAuditValue(created),
                },
            });
            return created;
        });

        return { ...endpoint, signingSecret: secret };
    }

    @Put(':id')
    @RequirePermission('settings:write')
    async update(@Param('id') id: string, @Body() body: EndpointMutationBody, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const data: { url?: string; events?: WebhookEventType[]; active?: boolean } = {};
        if (body?.url !== undefined) data.url = this.parseUrl(body.url);
        if (body?.events !== undefined) data.events = this.parseEvents(body.events);
        if (body?.active !== undefined) data.active = this.parseBoolean(body.active, 'active');
        if (Object.keys(data).length === 0) {
            throw new BadRequestException('At least one endpoint field is required');
        }

        return this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'webhooks');
            const existing = await tx.webhookEndpoint.findFirst({
                where: { id, tenantId },
                select: this.publicEndpointSelect(),
            });
            if (!existing) {
                throw new NotFoundException('Webhook endpoint not found');
            }
            const updated = await tx.webhookEndpoint.updateMany({
                where: { id, tenantId },
                data,
            });
            if (updated.count !== 1) {
                throw new NotFoundException('Webhook endpoint not found');
            }
            const endpoint = await tx.webhookEndpoint.findFirstOrThrow({
                where: { id, tenantId },
                select: this.publicEndpointSelect(),
            });
            await tx.auditLog.create({
                data: {
                    ...this.auditAttribution(req, tenantId),
                    action: WEBHOOK_ENDPOINT_AUDIT.updated,
                    resource: 'WebhookEndpoint',
                    resourceId: endpoint.id,
                    oldValue: this.endpointAuditValue(existing),
                    newValue: this.endpointAuditValue(endpoint),
                },
            });
            return endpoint;
        });
    }

    @Post(':id/rotate-secret')
    @RequirePermission('settings:write')
    async rotateSecret(@Param('id') id: string, @Req() req: any) {
        const tenantId = req.user.tenantId;
        const secret = this.generateSecret();
        const endpoint = await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'webhooks');
            const updated = await tx.webhookEndpoint.updateMany({
                where: { id, tenantId },
                data: { secret: this.deliveryCrypto.encryptString(secret) },
            });
            if (updated.count !== 1) {
                throw new NotFoundException('Webhook endpoint not found');
            }
            const rotated = await tx.webhookEndpoint.findFirstOrThrow({
                where: { id, tenantId },
                select: this.publicEndpointSelect(),
            });
            await tx.auditLog.create({
                data: {
                    ...this.auditAttribution(req, tenantId),
                    action: WEBHOOK_ENDPOINT_AUDIT.secretRotated,
                    resource: 'WebhookEndpoint',
                    resourceId: rotated.id,
                    newValue: { signingSecretRotated: true },
                },
            });
            return rotated;
        });
        return { ...endpoint, signingSecret: secret };
    }

    @Delete(':id')
    @RequirePermission('settings:write')
    @HttpCode(HttpStatus.NO_CONTENT)
    async deactivate(@Param('id') id: string, @Req() req: any): Promise<void> {
        const tenantId = req.user.tenantId;
        await this.tenantDb.withTenant(tenantId, async (tx) => {
            await this.featureAccessService.assertFeatureEntitledInTransaction(tx, tenantId, 'webhooks');
            const existing = await tx.webhookEndpoint.findFirst({
                where: { id, tenantId },
                select: { id: true, active: true },
            });
            if (!existing) {
                throw new NotFoundException('Webhook endpoint not found');
            }
            const updated = await tx.webhookEndpoint.updateMany({
                where: { id, tenantId },
                data: { active: false },
            });
            if (updated.count !== 1) {
                throw new NotFoundException('Webhook endpoint not found');
            }
            await tx.auditLog.create({
                data: {
                    ...this.auditAttribution(req, tenantId),
                    action: WEBHOOK_ENDPOINT_AUDIT.deactivated,
                    resource: 'WebhookEndpoint',
                    resourceId: id,
                    oldValue: { active: existing.active },
                    newValue: { active: false },
                },
            });
        });
    }

    private parseUrl(value: unknown): string {
        if (typeof value !== 'string' || !value.trim()) {
            throw new BadRequestException('url is required');
        }
        let parsed: URL;
        try {
            parsed = new URL(value.trim());
        } catch {
            throw new BadRequestException('url must be a valid HTTPS URL');
        }
        if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
            throw new BadRequestException('url must be a credential-free HTTPS URL');
        }
        if (parsed.search) {
            throw new BadRequestException('url query parameters are not supported; use a credential-free path URL');
        }
        parsed.hash = '';
        return parsed.toString();
    }

    private parseEvents(value: unknown): WebhookEventType[] {
        if (!Array.isArray(value) || value.length === 0) {
            throw new BadRequestException('events must contain at least one supported event');
        }
        const supported = new Set<string>(WEBHOOK_EVENT_TYPES);
        const events = Array.from(new Set(value));
        if (events.some((event) => typeof event !== 'string' || !supported.has(event))) {
            throw new BadRequestException(`events may contain only: ${WEBHOOK_EVENT_TYPES.join(', ')}`);
        }
        return events as WebhookEventType[];
    }

    private parseBoolean(value: unknown, field: string): boolean {
        if (typeof value !== 'boolean') {
            throw new BadRequestException(`${field} must be a boolean`);
        }
        return value;
    }

    private generateSecret(): string {
        return crypto.randomBytes(32).toString('base64url');
    }

    private auditAttribution(req: any, tenantId: string) {
        const actorUserId = req?.user?.sub;
        if (typeof actorUserId !== 'string' || !actorUserId.trim()) {
            throw new ForbiddenException('Authenticated user subject is required');
        }
        const forwardedFor = req?.headers?.['x-forwarded-for'];
        const userAgent = req?.headers?.['user-agent'];
        return {
            tenantId,
            userId: actorUserId,
            actorUserId,
            actorTenantId: tenantId,
            ipAddress: this.boundedHeader(
                typeof req?.ip === 'string' ? req.ip : Array.isArray(forwardedFor) ? forwardedFor[0] : forwardedFor,
                MAX_AUDIT_IP_LENGTH,
            ),
            userAgent: this.boundedHeader(Array.isArray(userAgent) ? userAgent[0] : userAgent, MAX_AUDIT_USER_AGENT_LENGTH),
        };
    }

    private boundedHeader(value: unknown, maxLength: number): string | null {
        return typeof value === 'string' && value.trim() ? value.trim().slice(0, maxLength) : null;
    }

    private endpointAuditValue(endpoint: EndpointAuditSource) {
        return {
            url: this.redactedAuditUrl(endpoint.url),
            events: endpoint.events
                .filter((event): event is string => typeof event === 'string' && WEBHOOK_EVENT_TYPES.includes(event as WebhookEventType))
                .slice(0, WEBHOOK_EVENT_TYPES.length),
            active: endpoint.active,
        };
    }

    private redactedAuditUrl(value: string): string {
        try {
            const parsed = new URL(value);
            const credentialFreeUrl = parsed.origin;
            return credentialFreeUrl.slice(0, MAX_AUDIT_URL_LENGTH);
        } catch {
            return '[redacted-invalid-url]';
        }
    }

    private publicEndpointSelect() {
        return {
            id: true,
            url: true,
            events: true,
            active: true,
            createdAt: true,
            updatedAt: true,
        } as const;
    }
}
