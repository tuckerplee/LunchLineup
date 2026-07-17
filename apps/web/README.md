# LunchLineup web app

Next.js frontend for the LunchLineup platform. The web app is deployed as the `web` Docker service and talks to the API through the configured backend URL.

## Folder map

- `README.md` - This web app folder guide.
- `.storybook/` - Storybook configuration for web UI review.
- `app/` - App Router pages, route layouts, and workspace surfaces; see `app/README.md`.
- `components/` - Shared React UI and branding components used across app routes.
- `lib/` - Web-side helpers for auth, API calls, session state, and formatting.
- `playwright-report/` - Generated Playwright HTML report artifacts when retained locally.
- `public/` - Static files served by Next.js; see `public/README.md`.
- `stories/` - Storybook stories for web components.
- `styles/` - Global styles and CSS tokens.
- `test-results/` - Generated Playwright test artifacts when retained locally.
- `tests/` - Playwright and frontend behavior tests.
- `middleware.ts` - Legacy Next.js middleware entry tracked in Git history; runtime auth logic has moved to `proxy.ts`.
- `proxy.ts` - Next.js request proxy for auth, exact public crawler/social metadata routes, strict bounded identity parsing with delimiter-safe role-ID forwarding and migration-safe role display names, approved-origin redirects, shared workspace permission prerequisites, and dashboard/admin redirects.
- `next-env.d.ts` - Generated Next.js TypeScript ambient declarations.
- `next.config.js` - Next.js configuration for the internal API rewrite, local-only images, production browser hardening, and CSP/header policy.
- `package.json` - Web package scripts and dependencies.
- `playwright.config.ts` - Browser test configuration with serialized mock-state runs, automatic safe ports, and an explicit validated signup-mode override for rendered onboarding gates.
- `postcss.config.js` - PostCSS configuration.
- `tailwind.config.js` - Tailwind configuration.
- `tsconfig.json` - TypeScript configuration.
- `tsconfig.tsbuildinfo` - TypeScript incremental build cache.
- `vitest.config.ts` - Vitest configuration.
- `vitest.shims.d.ts` - Vitest/browser shim declarations.

## Access behavior

`proxy.ts` allows users with `admin_portal:access` to access both the admin console and the team dashboard workspace. Super admins are not redirected away from `/dashboard`; the dashboard shell provides an Admin Console link when that permission is present. Scheduling access specifically requires effective `schedules:read`, `shifts:read`, and `locations:read` permissions. Lunch and break access requires effective `lunch_breaks:read` and `locations:read` permissions. These prerequisites stay aligned across the proxy, navigation, capability matrix, and page loaders; admin-portal access alone is not a bypass.

When the short-lived access cookie is missing or rejected, `proxy.ts` uses the HttpOnly refresh cookie plus the matching CSRF cookie/header contract through the internal API. It forwards a complete rotated access, refresh, and CSRF cookie set before retrying a sanitized same-origin path on the configured application origin. Definitively invalid sessions and invalid refresh responses redirect to login and clear session cookies. Network errors, upstream redirects, malformed/non-JSON auth payloads, rate limits, upstream failures, unsafe origin configuration, and other inconclusive auth-validation responses fail closed with a non-cacheable generic `503`; diagnostics expose only bounded classifications and preserve cookies for a bounded retry.

Custom role display names may contain punctuation and legacy rows may contain old control characters. The proxy normalizes names for display parsing but keeps them out of identity headers, forwarding only validated role IDs. A user may hold at most 100 deduplicated role assignments; the proxy accepts that exact bound and rejects overflow before header construction. Canonical legacy roles and effective permissions retain strict token validation.

Crawler and social metadata bypass authentication only at the exact `/robots.txt`, `/sitemap.xml`, and `/opengraph-image` paths. Metadata-like descendants and all other private routes continue through the normal auth proxy, while Next.js retains the metadata response cache, content-type, and security headers.
