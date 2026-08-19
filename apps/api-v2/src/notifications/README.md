# API v2 Notifications

## Files

- `README.md`: module guide and file inventory.
- `routes.ts`: explicit Fastify/OpenAPI routes for notification feed and read-state commands.
- `notifications.service.ts`: tenant-RLS feed pagination, public-ID serialization, unread counts, and read-state persistence.
- `notifications.service.test.ts`: cursor, tenant, public-identifier, and read-state regression tests.

The module owns `GET /notifications`, `POST /notifications/read`, and `POST /notifications/read-all`. It reads the durable notification feed directly from PostgreSQL; schedule publication may continue to create feed rows through its outbox while that separate scheduling seam is retained.
