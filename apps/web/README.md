# LunchLineup web app

Next.js frontend for the LunchLineup platform. The web app is deployed as the `web` Docker service and talks to the API through the configured backend URL.

## Folder map

- `app/` - App Router pages, route layouts, and workspace surfaces.
- `components/` - Shared React UI and branding components used across app routes.
- `hooks/` - Reusable client-side React hooks.
- `lib/` - Web-side helpers for auth, API calls, session state, and formatting.
- `public/` - Static files served by Next.js; see `public/README.md`.
- `stories/` - Storybook stories for web components.
- `styles/` - Global styles and CSS tokens.
- `tests/` - Playwright and frontend behavior tests.
- `middleware.ts` - Route guard for auth, role access, and dashboard/admin redirects.
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

`middleware.ts` allows users with `admin_portal:access` to access both the admin console and the team dashboard workspace. Super admins are not redirected away from `/dashboard`; the dashboard shell provides an Admin Console link when that permission is present.
