# App routes

Next.js App Router entrypoints for the LunchLineup web app.

## File map

- `README.md` - This route folder guide.
- `error.tsx` - Recoverable root segment error state with retry and dashboard escape.
- `global-error.tsx` - Last-resort document recovery state when the root layout fails.
- `loading.tsx` - Accessible root navigation loading state.
- `legal-config.ts` - Shared public legal contacts, self-service Terms readiness, last-updated value, and subprocessor metadata.
- `legal-page.tsx` - Shared public legal/trust page shell.
- `layout.tsx` - Root canonical, social metadata, favicon link, and global CSS import.
- `opengraph-image.tsx` - Generated 1200x630 social preview image.
- `page.tsx` - Public SaaS entry page with mode-gated onboarding and existing-workspace sign-in links.
- `robots.ts` - Public crawler policy that excludes authenticated and API routes.
- `sitemap.ts` - Canonical public-route sitemap.
- `admin/` - Platform administration routes; see `admin/README.md`.
- `api/` - Web-side API route handlers.
- `auth/` - Login/logout routes.
- `dashboard/` - Tenant workspace routes; see `dashboard/README.md`.
- `mfa/` - MFA verification route for unverified sessions.
- `onboarding/` - Account/workspace onboarding route; see `onboarding/README.md`.
- `privacy/` - Public privacy route.
- `security/` - Public security route.
- `status/` - Public beta status route with automated web/API health signals and incident history.
- `subprocessors/` - Public beta subprocessor list and DPA request route.
- `terms/` - Public beta service terms and acceptable-use route.
