# Admin console

System administration routes for super admins and users with `admin_portal:access`.

## File map

- `layout.tsx` - Admin shell, admin navigation, and permission gate.
- `page.tsx` - Admin overview route.
- `credits/` - Tenant usage credit administration.
- `plans/` - Plan and subscription configuration.
- `tenants/` - Tenant/company administration.
- `users/` - Platform user administration.

## Access behavior

The admin console remains restricted to users with `admin_portal:access`. The admin shell and overview expose direct workspace links for Calendar (`/dashboard/scheduling`), Team Dashboard, Lunch & Breaks, Staff, and Locations so super admins can move between admin operations and usable calendar/usage workflows without guessing where the workspace lives. Sidebar links use icon components, not text prefixes.
