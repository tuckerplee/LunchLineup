# Dashboard workspace

Team workspace routes for schedules, staff, locations, lunch breaks, settings, and tenant usage visibility.

## File map

- `layout.tsx` - Authenticated dashboard shell, navigation, notifications, and role-aware links.
- `page.tsx` - Dashboard overview route.
- `DashboardWorkspace.tsx` - Client dashboard overview with schedule and usage summaries.
- `scheduling/` - Tenant-scoped calendar and schedule editing flow; see `scheduling/README.md`.
- `lunch-breaks/` - Lunch and break tracking flow with usage credit display; see `lunch-breaks/README.md`.
- `staff/` - Staff management workspace.
- `locations/` - Location and store management workspace.
- `settings/` - Tenant settings workspace.

## Access behavior

The dashboard is available to normal workspace users and super admins. Users with `admin_portal:access` keep calendar, scheduling, and usage access here. The calendar navigation label points to `/dashboard/scheduling`, and super admins also see an Admin Console navigation item for `/admin`.
