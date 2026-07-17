# Admin console

System administration routes for super admins and users with `admin_portal:access`.

## File map

- `README.md` - This admin route folder guide.
- `layout.tsx` - Admin shell, responsive top-bar sign-out, environment/user labeling, and permission gate.
- `AdminNav.tsx` - Client route-aware admin navigation grouped by team operations and platform admin routes.
- `admin-list-pagination.ts` - Shared page-metadata parser, encoded admin-list URL builder, and explicit-page deduplication helper; it never follows continuations automatically.
- `page.tsx` - Admin overview route.
- `credits/` - Tenant usage credit administration; see `credits/README.md`.
- `plans/` - Plan and subscription configuration; see `plans/README.md`.
- `tenants/` - Tenant/company administration.
- `users/` - Platform user administration.

## Access behavior

The admin console remains restricted to users with `admin_portal:access`. The admin shell and overview expose direct workspace links for Calendar (`/dashboard/scheduling`), Team Dashboard, Lunch & Breaks, Staff, and Locations so super admins can move between admin operations and usable calendar/usage workflows without guessing where the workspace lives. Sidebar links use icon components, not text prefixes.
