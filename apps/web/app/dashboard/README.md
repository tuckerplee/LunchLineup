# Dashboard workspace

Team workspace routes for schedules, staff, locations, lunch breaks, time cards, settings, and tenant usage visibility.

## File map

- `README.md` - This dashboard route folder guide.
- `dashboard-navigation.ts` - Pure desktop/mobile navigation grouping, shared permission filtering, current-page, and account-initial helpers for the dashboard shell; items do not display counts without an authoritative source.
- `DashboardMobileNavigation.tsx` - Permission-aware Home/Schedule/Breaks/Team/More mobile navigation with an accessible keyboard-operated overflow menu.
- `layout.tsx` - Authenticated dashboard shell that owns session-aware desktop navigation and notification data loading while delegating the mobile navigation interaction.
- `NotificationsMenu.tsx` - Focus-managed notification trigger/dialog with Tab trapping, Escape closure, trigger-focus restoration, and read actions.
- `page.tsx` - Dashboard overview route.
- `DashboardWorkspace.tsx` - Manager overview with one permission-aware Needs attention queue, a concise This week status, bounded operational reads, and unavailable/retry states that distinguish failed reads from legitimate zero/empty data.
- `scheduling/` - Tenant-scoped calendar and schedule editing flow; see `scheduling/README.md`.
- `lunch-breaks/` - Lunch and break tracking flow with usage credit display; see `lunch-breaks/README.md`.
- `time-cards/` - Time clock and timecard tracking flow; see `time-cards/README.md`.
- `payroll/` - MFA-protected payroll policies, pay periods, review, immutable exports, amendments, and reconciliation; see `payroll/README.md`.
- `staff/` - Staff management workspace.
- `locations/` - Location and store management workspace.
- `settings/` - Tenant settings workspace; see `settings/README.md`.

## Access behavior

The dashboard is available to normal workspace users and super admins. Navigation and overview actions are permission-aware: calendar access requires the complete `schedules:read`, `shifts:read`, and `locations:read` contract; lunch and break access requires both `lunch_breaks:read` and `locations:read`; create/update actions require the matching write permission. On mobile, the visible primary destinations are Home, Schedule, Breaks, and Team; every other permitted destination is in More. `admin_portal:access` adds the Admin Console navigation item for `/admin` but does not bypass tenant workspace permissions.
