# LunchLineup SaaS UI Overhaul

## 1. Design Direction
- Tone: friendly, energetic, modern, and professional.
- Theme: light-first SaaS surfaces with layered cards.
- Visual depth: soft elevation and subtle gradients over flat gray panels.

## 2. Color System
- Primary: `#2f63ff` with gradient companions (`#4171ff`, `#22b8cf`) for key actions.
- Secondary accents: cyan (`#22b8cf`), emerald (`#17b26a`), amber (`#f59e0b`), rose (`#e74867`).
- Neutral system: light cool grays from `#f8faff` to `#1d2538`.
- Semantic states:
  - Success: emerald
  - Warning: amber
  - Error: rose
- Token source: `apps/web/styles/globals.css`.

## 3. Spacing + Layout
- Base rhythm: 8px system (`--space-2` to `--space-24`).
- Workspace shell: floating sidebar + sticky topbar + card-based content sections.
- Page composition: modular panels with consistent gaps and large page breathing room.

## 4. Component System
- Buttons: rounded, tactile, gradient primary CTA with subtle hover lift.
- Inputs: soft white surfaces, visible borders, clear focus rings.
- Cards: rounded elevated containers with layered hover states.
- Navigation: icon-led links, clear active state, and soft hover transitions.
- Tables: light headers, readable typography, clear row separators.

## 5. Motion Guidelines
- Fast, purposeful transitions (`160ms` to `420ms` ranges).
- Card and button hover elevation.
- Skeleton loading placeholders for heavy surfaces.
- Smooth bar and panel reveal animations for data blocks.

## 6. Interaction Patterns
- Primary flow ordering is consistent across workspaces:
  1. Select context (location/date/filters)
  2. Add or edit data
  3. Run action (auto-schedule/generate/publish)
  4. Review results
  5. Confirm/persist
- Controls avoid backend language and remain task-oriented.

## 7. Implemented Visual Examples
- Workspace shell/navigation: `apps/web/app/dashboard/layout.tsx`
- Dashboard overview: `apps/web/app/dashboard/page.tsx`
- Scheduling workspace: `apps/web/app/dashboard/scheduling/page.tsx`
- Staff workspace: `apps/web/app/dashboard/staff/page.tsx`
- Locations workspace: `apps/web/app/dashboard/locations/page.tsx`
- Settings workspace: `apps/web/app/dashboard/settings/page.tsx`
- Scheduler visual theme: `apps/web/components/scheduling/StaffScheduler.tsx`
- Shared primitives: `apps/web/components/ui/button.tsx`, `apps/web/components/ui/card.tsx`

## 8. Admin Console Redesign
- Applied the same light SaaS system to the system-admin experience with a distinct rose accent to differentiate platform-level controls.
- Updated shell + pages:
  - `apps/web/app/admin/layout.tsx`
  - `apps/web/app/admin/page.tsx`
  - `apps/web/app/admin/tenants/page.tsx`
  - `apps/web/app/admin/users/page.tsx`
  - `apps/web/app/admin/credits/page.tsx`
- Preserved existing data wiring and role gating while improving readability, hierarchy, and responsiveness.
