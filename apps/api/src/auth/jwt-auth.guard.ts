import { Injectable, CanActivate, ExecutionContext, UnauthorizedException, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { JwtService } from './jwt.service';
import { RbacService } from './rbac.service';

const ACCESS_TOKEN_COOKIE_MAX_AGE_MS = 30 * 60 * 1000;

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
        private rbacService: RbacService,
        private reflector: Reflector,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const isPublic = this.reflector.get<boolean>('isPublic', context.getHandler());
        if (isPublic) return true;

        const request = context.switchToHttp().getRequest();
        const authHeader = request.headers['authorization'];

        if (!authHeader || !authHeader.startsWith('Bearer ')) {
            // Fall back to cookie-based auth
            const accessToken = request.cookies?.['access_token'];
            if (!accessToken) {
                throw new UnauthorizedException('No authentication token provided');
            }

            try {
                const verified = this.jwtService.verifyAccessToken(accessToken);
                const access = await this.rbacService.getEffectiveAccess(verified.sub, verified.tenantId);
                request.user = {
                    ...verified,
                    legacyRole: verified.legacyRole,
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
                    }), {
                        httpOnly: true,
                        secure: process.env.NODE_ENV === 'production',
                        sameSite: 'strict',
                        path: '/',
                        maxAge: ACCESS_TOKEN_COOKIE_MAX_AGE_MS,
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
            const access = await this.rbacService.getEffectiveAccess(verified.sub, verified.tenantId);
            request.user = {
                ...verified,
                legacyRole: verified.legacyRole,
                permissions: access.permissions,
                roles: access.roles,
                role: access.primaryRole,
            };
            return true;
        } catch {
            throw new UnauthorizedException('Invalid access token');
        }
    }
}
