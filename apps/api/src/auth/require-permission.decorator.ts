import { SetMetadata } from '@nestjs/common';

export const PERMISSION_METADATA_KEY = 'permission';
export const ALLOW_AUTHENTICATED_METADATA_KEY = 'allowAuthenticated';

/**
 * Decorator to enforce Casbin RBAC permissions on a route route.
 * @param permission Format is "resource:action" (e.g., "billing:write")
 */
export const RequirePermission = (permission: string) => SetMetadata(PERMISSION_METADATA_KEY, permission);

/**
 * Decorator for routes that intentionally require only an authenticated session.
 */
export const AllowAuthenticated = () => SetMetadata(ALLOW_AUTHENTICATED_METADATA_KEY, true);
