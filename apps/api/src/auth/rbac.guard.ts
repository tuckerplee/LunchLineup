import { Injectable, CanActivate, ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { newEnforcer, Enforcer, MODEL_PATH, POLICY_PATH } from '@lunchlineup/rbac';

/**
 * RBAC Guard using Casbin.
 * Enforces permission checks at the middleware level.
 * Architecture Part VII — Policy-based Default Deny.
 */
@Injectable()
export class RbacGuard implements CanActivate {
    private enforcer: Enforcer | null = null;

    constructor(private reflector: Reflector) { }

    private async getEnforcer(): Promise<Enforcer> {
        if (!this.enforcer) {
            this.enforcer = await newEnforcer(MODEL_PATH, POLICY_PATH);
        }
        return this.enforcer;
    }

    async canActivate(context: ExecutionContext): Promise<boolean> {
        const requiredPermission = this.reflector.get<string>('permission', context.getHandler());
        if (!requiredPermission) return true; // No permission annotation = no check required

        const request = context.switchToHttp().getRequest();
        const user = request.user;

        if (!user) {
            throw new ForbiddenException('No user context — authentication required');
        }

        const enforcer = await this.getEnforcer();
        const [resource, action] = requiredPermission.split(':');

        const allowed = await enforcer.enforce(user.role, resource, action);
        if (!allowed) {
            // Log RBAC denial for security dashboarding
            console.warn(`RBAC DENY: user=${user.sub} role=${user.role} resource=${resource} action=${action}`);
            throw new ForbiddenException(`Insufficient permissions for ${resource}:${action}`);
        }

        return true;
    }
}
