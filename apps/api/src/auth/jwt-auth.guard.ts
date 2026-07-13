import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import crypto from 'crypto';
import { readFileSync } from 'fs';
import { JwtService } from './jwt.service';
import { RbacService } from './rbac.service';
import { AuthService } from './auth.service';

const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;
const RETENTION_PURGE_PERMISSION = 'admin_portal:access';

function useSecureCookies(): boolean {
    const configured = process.env.COOKIE_SECURE;
    if (configured !== undefined) {
        return ['1', 'true', 'yes', 'on'].includes(configured.toLowerCase());
    }
    return process.env.NODE_ENV === 'production';
}

/**
 * JWT Authentication Guard.
 * Validates the access token and attaches the user context to the request.
 * Architecture Part VII — Default Deny.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
    private readonly logger = new Logger(JwtAuthGuard.name);

    constructor(
        private jwtService: JwtService,
        private authService: AuthService,
        private rbacService: RbacService,
        private reflector: Reflector,
    ) { }

    private isMfaCompletionRoute(request: any): boolean {
        const method = String(request.method || '').toUpperCase();
        const path = String(request.path || request.originalUrl || request.url || '').split('?')[0];
        return (method === 'POST' && path.endsWith('/auth/mfa/verify'))
            || (method === 'POST' && path.endsWith('/auth/mfa/enroll'))
            || (method === 'POST' && path.endsWith('/auth/mfa/enroll/confirm'))
            || (method === 'GET' && path.endsWith('/auth/mfa/enrollment'))
            || (method === 'POST' && path.endsWith('/auth/mfa/enrollment'))
            || (method === 'PUT' && path.endsWith('/auth/mfa/enrollment'))
            || (method === 'POST' && path.endsWith('/auth/logout'))
            || (method === 'GET' && path.endsWith('/auth/me'))
            || (method === 'POST' && path.endsWith('/auth/refresh'));
    }

    private enforceMfaBoundary(request: any): void {
        if (request.user?.mfaRequired && !request.user?.mfaVerified && !this.isMfaCompletionRoute(request)) {
            throw new ForbiddenException('MFA verification required');
        }
    }

    private isPinResetRoute(request: any): boolean {
        const method = String(request.method || '').toUpperCase();
        const path = String(request.path || request.originalUrl || request.url || '').split('?')[0];
        return (method === 'PUT' && path.endsWith('/users/me/pin'))
            || (method === 'POST' && path.endsWith('/auth/logout'))
            || (method === 'GET' && path.endsWith('/auth/me'))
            || (method === 'POST' && path.endsWith('/auth/refresh'));
    }

    private enforceSessionBoundaries(request: any): void {
        if (request.user?.pinResetRequired) {
            if (!this.isPinResetRoute(request)) {
                throw new ForbiddenException('PIN rotation required');
            }
            return;
        }
        this.enforceMfaBoundary(request);
    }

    private isRetentionPurgeRoute(request: any): boolean {
        const method = String(request.method || '').toUpperCase();
        const path = String(request.path || request.originalUrl || request.url || '').split('?')[0];
        return method === 'POST' && path.endsWith('/admin/retention/purge-expired');
    }

    private retentionPurgeServiceToken(): string | null {
        const direct = process.env.RETENTION_PURGE_SERVICE_TOKEN?.trim();
        if (direct) return direct;

        const tokenFile = process.env.RETENTION_PURGE_SERVICE_TOKEN_FILE?.trim();
        if (!tokenFile) return null;
        try {
            return readFileSync(tokenFile, 'utf8').trim() || null;
        } catch {
            return null;
        }
    }

    private hasRetentionPurgeServiceToken(request: any): boolean {
        const authHeader = String(request.headers?.authorization ?? '');
        if (!authHeader.startsWith('Bearer ')) return false;
        const supplied = authHeader.slice('Bearer '.length).trim();
        const expected = this.retentionPurgeServiceToken();
        if (!supplied || !expected) return false;

        const suppliedBuffer = Buffer.from(supplied);
        const expectedBuffer = Buffer.from(expected);
        return suppliedBuffer.length === expectedBuffer.length
            && crypto.timingSafeEqual(suppliedBuffer, expectedBuffer);
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
        if (isPublic) return true;

        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers['authorization'];

        if (this.isRetentionPurgeRoute(request) && this.hasRetentionPurgeServiceToken(request)) {
            request.user = {
                sub: 'service:retention-purge',
                tenantId: '__platform__',
                role: 'System Service',
                legacyRole: null,
                mfaRequired: false,
                mfaVerified: true,
                permissions: [RETENTION_PURGE_PERMISSION],
                roles: [{ id: 'service:retention-purge', name: 'Retention Purge Service' }],
                service: 'retention-purge',
            };
            return true;
        }

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // Fall back to cookie-based auth
            const accessToken = request.cookies?.['access_token'];
            if (!accessToken) {
                throw new UnauthorizedException('No authentication token provided');
            }

            try {
                const verified = this.jwtService.verifyAccessToken(accessToken);
                const sessionState = await this.authService.validateAccessSession(verified);
                const access = await this.rbacService.getEffectiveAccess(verified.sub, verified.tenantId);
                request.user = {
                    ...verified,
                    legacyRole: sessionState.legacyRole,
                    mfaRequired: sessionState.mfaRequired,
                    mfaVerified: sessionState.mfaVerified,
                    pinResetRequired: sessionState.pinResetRequired,
                    permissions: access.permissions,
                    roles: access.roles,
                    role: access.primaryRole,
                };

                // Validate CSRF for cookie-based requests (Double-Submit pattern)
                if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(request.method)) {
                    const csrfHeader = request.headers['x-csrf-token'];
                    const csrfCookie = request.cookies?.['csrf_token'];
                    if (!csrfHeader || !csrfCookie || csrfHeader !== csrfCookie) {
                        throw new ForbiddenException('CSRF validation failed');
                    }
                }
                this.enforceSessionBoundaries(request);

                const response = context.switchToHttp().getResponse();
                // Rotate cookie with canonical claims only (exclude exp/iat/iss/aud from decoded payload).
                try {
                    response.cookie('access_token', this.jwtService.generateAccessToken({
                        sub: request.user.sub,
                        tenantId: request.user.tenantId,
                        role: request.user.role,
                        legacyRole: request.user.legacyRole,
                        sessionId: request.user.sessionId,
                        mfaVerified: request.user.mfaVerified,
                        pinResetRequired: request.user.pinResetRequired,
                    }), {
                        httpOnly: true,
                        secure: useSecureCookies(),
                        sameSite: 'strict',
                        path: '/',
                        maxAge: sessionState.accessTokenMaxAgeMs ?? ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
                    });
                } catch (rotationError) {
                    // Auth should not fail if sliding rotation fails.
                    this.logger.warn(
                        `Access token rotation skipped: ${rotationError instanceof Error ? rotationError.message : 'unknown_error'}`,
                    );
                }

                return true;
            } catch (err) {
                if (err instanceof ForbiddenException) throw err;
                throw new UnauthorizedException('Invalid access token');
            }
        }

        // Bearer token auth (inherently CSRF-immune)
        const token = authHeader.split(' ')[1];
        try {
            const verified = this.jwtService.verifyAccessToken(token);
            const sessionState = await this.authService.validateAccessSession(verified);
            const access = await this.rbacService.getEffectiveAccess(verified.sub, verified.tenantId);
            request.user = {
                ...verified,
                legacyRole: sessionState.legacyRole,
                mfaRequired: sessionState.mfaRequired,
                mfaVerified: sessionState.mfaVerified,
                pinResetRequired: sessionState.pinResetRequired,
                permissions: access.permissions,
                roles: access.roles,
                role: access.primaryRole,
            };
            this.enforceSessionBoundaries(request);
            return true;
        } catch (err) {
            if (err instanceof ForbiddenException) throw err;
            throw new UnauthorizedException('Invalid access token');
        }
    }
}
