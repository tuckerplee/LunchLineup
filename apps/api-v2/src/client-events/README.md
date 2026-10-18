# API v2 Client Events

## Files

- `README.md`: module guide.
- `routes.ts`: `POST /v2/client-events` route, route normalization, and the `ui_message` log record builder.
- `routes.test.ts`: validation, authenticated-context, CSRF, batch-bound, and rate-limit regressions.

The web app reports UI message and confirm outcomes here. Events carry only an allow-listed stable `code`, `level`, `kind`, normalized `route`, optional confirm `outcome`, and an optional short non-PII `detail` key. `tenantId` and `userId` are attached from the authenticated session, never the body. Each event becomes one pino line with `event: "ui_message"`; container stdout is shipped to Loki, so nothing is persisted here.
