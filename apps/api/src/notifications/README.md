# API notifications

## Files

- `README.md`: this notifications folder guide.
- `notifications.controller.spec.ts`: controller tests for listing and marking notification feed entries.
- `notifications.controller.ts`: authenticated HTTP routes for notification feed operations.
- `notifications.constants.ts`: legacy constants module tracked in Git history; notification types now live in `notifications.service.ts`.
- `notifications.module.ts`: Nest module wiring for notification routes and services.
- `notifications.service.spec.ts`: service tests for tenant-scoped notification persistence and reads.
- `notifications.service.ts`: notification persistence, unread counts, read markers, and optional Redis fan-out.
