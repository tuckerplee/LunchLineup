# LunchLineup web app

Next.js frontend for the LunchLineup platform. The web app is deployed as the `web` Docker service and talks to the API through the configured backend URL.

## Folder map

- `README.md` - This web app folder guide.
- `.storybook/` - Storybook configuration for web UI review.
- `app/` - App Router pages, route layouts, and workspace surfaces; see `app/README.md`.
- `components/` - Shared React UI and branding components used across app routes.
- `hooks/` - Reusable client-side React hooks.
- `lib/` - Web-side helpers for auth, API calls, session state, and formatting.
- `playwright-report/` - Generated Playwright HTML report artifacts when retained locally.
- `public/` - Static files served by Next.js; see `public/README.md`.
- `stories/` - Storybook stories for web components.
- `styles/` - Global styles and CSS tokens.
- `test-results/` - Generated Playwright test artifacts when retained locally.
- `tests/` - Playwright and frontend behavior tests.
- `middleware.ts` - Legacy Next.js middleware entry tracked in Git history; runtime auth logic has moved to `proxy.ts`.
- `proxy.ts` - Next.js request proxy for auth, shared workspace permission prerequisites, and dashboard/admin redirects.
- `next-env.d.ts` - Generated Next.js TypeScript ambient declarations.
- `next.config.js` - Next.js configuration.
- `package.json` - Web package scripts and dependencies.
- `playwright.config.ts` - Browser test configuration.
- `postcss.config.js` - PostCSS configuration.
- `tailwind.config.js` - Tailwind configuration.
- `tsconfig.json` - TypeScript configuration.
- `tsconfig.tsbuildinfo` - TypeScript incremental build cache.
- `vitest.config.ts` - Vitest configuration.
- `vitest.shims.d.ts` - Vitest/browser shim declarations.

## Access behavior

`proxy.ts` allows users with `admin_portal:access` to access both the admin console and the team dashboard workspace. Super admins are not redirected away from `/dashboard`; the dashboard shell provides an Admin Console link when that permission is present. Scheduling access specifically requires effective `schedules:read`, `shifts:read`, and `locations:read` permissions. Lunch and break access requires effective `lunch_breaks:read` and `locations:read` permissions. These prerequisites stay aligned across the proxy, navigation, capability matrix, and page loaders; admin-portal access alone is not a bypass.

When the short-lived access cookie is missing or rejected, `proxy.ts` uses the HttpOnly refresh cookie plus the matching CSRF cookie/header contract through the internal API. It forwards a complete rotated access, refresh, and CSRF cookie set before retrying the original URL. Definitively invalid sessions and invalid refresh responses redirect to login and clear session cookies. Network errors, rate limits, upstream failures, and other inconclusive auth-validation responses fail closed with a non-cacheable `503` and preserve the cookies for a bounded retry.
