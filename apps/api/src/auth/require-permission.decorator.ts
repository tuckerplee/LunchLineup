import { SetMetadata } from '@nestjs/common';

/**
 * Decorator to enforce Casbin RBAC permissions on a route route.
 * @param permission Format is "resource:action" (e.g., "billing:write")
 */
export const RequirePermission = (permission: string) => SetMetadata('permission', permission);
