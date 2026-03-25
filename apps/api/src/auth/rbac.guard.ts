import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RbacService } from './rbac.service';

/**
 * RBAC Guard using Casbin.
 * Enforces permission checks at the middleware level.
 * Architecture Part VII — Policy-based Default Deny.
 */
@Injectable()
export class RbacGuard implements CanActivate {
    constructor(
        private reflector: Reflector,
        private rbacService: RbacService,
    ) { }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const requiredPermission = this.reflector.get<string>('permission', context.getHandler());
        if (!requiredPermission) return true; // No permission annotation = no check required

        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user) {
            throw new ForbiddenException('No user context — authentication required');
        }

        const permissions = Array.isArray(user.permissions)
            ? user.permissions
            : (await this.rbacService.getEffectiveAccess(user.sub, user.tenantId)).permissions;

        const allowed = permissions.includes(requiredPermission);
        if (!allowed) {
            console.warn(`RBAC DENY: user=${user.sub} role=${user.role} permission=${requiredPermission}`);
            throw new ForbiddenException(`Insufficient permissions for ${requiredPermission}`);
        }

        return true;
    }
}
