# Dashboard workspace

Team workspace routes for schedules, staff, locations, lunch breaks, time cards, settings, and tenant usage visibility.

## File map

- `README.md` - This dashboard route folder guide.
- `dashboard-navigation.ts` - Pure navigation, shared permission filtering, current-page, and account-initial helpers for the dashboard shell.
- `layout.tsx` - Authenticated dashboard shell, navigation, notifications, and role-aware links.
- `page.tsx` - Dashboard overview route.
- `DashboardWorkspace.tsx` - Client dashboard overview with schedule and usage summaries.
- `scheduling/` - Tenant-scoped calendar and schedule editing flow; see `scheduling/README.md`.
- `lunch-breaks/` - Lunch and break tracking flow with usage credit display; see `lunch-breaks/README.md`.
- `time-cards/` - Time clock and timecard tracking flow; see `time-cards/README.md`.
- `staff/` - Staff management workspace.
- `locations/` - Location and store management workspace.
- `settings/` - Tenant settings workspace; see `settings/README.md`.

## Access behavior

The dashboard is available to normal workspace users and super admins. Navigation and overview actions are permission-aware: calendar access requires the complete `schedules:read`, `shifts:read`, and `locations:read` contract; lunch and break access requires both `lunch_breaks:read` and `locations:read`; create/update actions require the matching write permission. `admin_portal:access` adds the Admin Console navigation item for `/admin` but does not bypass tenant workspace permissions.
