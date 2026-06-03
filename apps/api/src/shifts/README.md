# API shifts

## Files

- `README.md`: this shifts folder guide.
- `shifts.controller.ts`: tenant-scoped shift CRUD, staff roster, and bulk assignment endpoints.
- `shifts.controller.spec.ts`: focused tests for notifications, tenant-scoped staff roster, and shift controller behavior.

## Notes

Shift reads include linked staff and break records for calendar consumers. Scheduler-facing reads and rosters only include open shifts, managers, and staff; admins and super admins are excluded from planner/lunch-break assignment surfaces. Create, update, and bulk assignment paths validate location/user ownership against `req.user.tenantId` so calendar actions cannot cross tenant boundaries.
