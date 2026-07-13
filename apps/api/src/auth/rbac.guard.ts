import { Injectable, CanActivate, ExecutionContext, ForbiddenException, Logger } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacService } from './rbac.service';
import { ALLOW_AUTHENTICATED_METADATA_KEY, PERMISSION_METADATA_KEY } from './require-permission.decorator';

/**
 * RBAC Guard using Casbin.
 * Enforces permission checks at the middleware level.
 * Architecture Part VII - Policy-based Default Deny.
 */
@Injectable()
export class RbacGuard implements CanActivate {
    private readonly logger = new Logger(RbacGuard.name);

    constructor(
        private reflector: Reflector,
        private rbacService: RbacService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const metadataTargets = [context.getHandler(), context.getClass()];
        const isPublic = this.reflector.getAllAndOverride<boolean>('isPublic', metadataTargets);
        if (isPublic) return true;

        const allowAuthenticated = this.reflector.getAllAndOverride<boolean>(
            ALLOW_AUTHENTICATED_METADATA_KEY,
            metadataTargets,
        );
        const requiredPermission = this.reflector.getAllAndOverride<string | string[]>(
            PERMISSION_METADATA_KEY,
            metadataTargets,
        );

        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user) {
            throw new ForbiddenException('No user context - authentication required');
        }

        if (allowAuthenticated) return true;

        const requiredPermissions = Array.isArray(requiredPermission)
            ? requiredPermission
            : requiredPermission
                ? [requiredPermission]
                : [];
        if (requiredPermissions.length === 0) {
            throw new ForbiddenException('Route is missing RBAC permission metadata');
        }

        const permissions = Array.isArray(user.permissions)
            ? user.permissions
            : (await this.rbacService.getEffectiveAccess(user.sub, user.tenantId)).permissions;

        const missingPermissions = requiredPermissions.filter((permission) => !permissions.includes(permission));
        if (missingPermissions.length > 0) {
            this.logger.warn(`RBAC deny role=${String(user.role ?? 'unknown')} permissions=${missingPermissions.join(',')}`);
            throw new ForbiddenException(`Insufficient permissions for ${missingPermissions.join(', ')}`);
        }

        return true;
    }
}
