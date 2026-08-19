# LunchLineup Brand Bible

Status: beta homepage design source of truth
Last reviewed: 2026-07-22

This document defines the product story, visual system, voice, and public-homepage rules for LunchLineup. It is grounded in the current application, its public beta security commitments, the legacy homepage, and a July 2026 review of ten current SaaS homepages.

## 1. Brand core

### What LunchLineup is

LunchLineup is an operational workspace for teams that run on shifts. It helps managers turn availability, staffing needs, lunches, breaks, and location context into a schedule that can be reviewed, published, and carried into time-card and payroll-review workflows.

LunchLineup is not a generic calendar, a chat app, a payroll processor, or an AI promise. The schedule is the center of the product.

### Audience

- Frontline managers who build and adjust schedules.
- Operators responsible for coverage across one or more locations.
- Owners and administrators who manage staff access, scheduling profiles, time cards, and payroll review.
- Shift workers who need a clear, dependable view of when they work.

Restaurants are an important native context inherited from the original product, but the public promise should remain useful to any modern shift-work team.

### Job to be done

> Help me build a workable schedule, see problems before the shift starts, and keep the operational record moving after it ends.

### Positioning

For shift-work teams that have outgrown spreadsheets and disconnected tools, LunchLineup is the schedule-centered operations workspace that keeps availability, breaks, coverage, publishing, time review, and staff context in one clear flow.

### Brand promise

**The schedule, already thinking ahead.**

This means the interface presents the context a manager needs before an edit: who is available, where coverage is thin, when breaks fit, what is published, and what needs review. It does not promise autonomous decisions, legal compliance, or perfect outcomes.

### Value hierarchy

1. **Clarity:** see the week, the people, and the coverage state together.
2. **Foresight:** plan availability, lunches, breaks, and demand before publishing.
3. **Flow:** move from draft to published schedule to time and payroll review without losing context.
4. **Control:** use location scope, roles, permissions, and review steps for sensitive actions.
5. **Respect:** design around the time of managers and shift workers.

## 2. Personality

- **Composed, not corporate.** Calm structure and confident hierarchy without enterprise theater.
- **Capable, not complicated.** Product depth is visible, but the next action stays obvious.
- **Human, not cute.** Friendly language and rounded details without cartoons or forced cheer.
- **Operational, not technical.** Talk about shifts, people, locations, breaks, coverage, and review rather than infrastructure.
- **Optimistic, not loud.** Use color to guide attention, not fill every surface.

The personality blend is restaurant-floor energy plus control-room precision.

## 3. Voice and copy

### Voice rules

- Lead with an outcome, then explain the mechanism.
- Prefer short, concrete sentences and active verbs.
- Name real product objects: schedule, shift, location, availability, lunch, break, coverage, time card, review.
- Use "team" and "people" more often than "workforce."
- Use "manager" only when a workflow is genuinely manager-specific.
- Keep humor out of destructive, security, payroll, and compliance states.

### Preferred vocabulary

Build the week; see the whole shift; plan breaks; protect coverage; publish with context; keep everyone aligned; review the day; payroll-ready review; one operational flow; your workspace.

### Avoid

- Revolutionize, supercharge, game-changing, seamless, effortless.
- AI-powered or autonomous unless a shipped user-facing feature supports the exact claim.
- Fully compliant, compliance guaranteed, conflict-free, perfect schedule.
- Payroll processing, tax filing, or employee payment.
- Team chat or messaging; LunchLineup currently exposes operational notifications.
- Unverified savings, customer counts, ratings, logos, or performance percentages.
- "All-in-one" when it implies unfinished integrations or product areas.

### Headline and CTA behavior

Headlines are plainspoken and slightly memorable: "The schedule, already thinking ahead.", "Build the week. See the whole shift.", and "Every shift in context." Do not place a decorative eyebrow, badge, or pill above the homepage H1.

- Primary when signup is enabled: **Create your workspace**
- Primary when signup is closed: **Open beta workspace**
- Persistent account action: **Sign in**
- Product exploration: **See how it works**
- Do not use "Get started free," "Start trial," or "Book a demo" until those paths are real.

## 4. Visual identity

### Creative idea: the living shift line

A precise horizontal schedule rail moves through the brand system, connecting people, time, breaks, coverage, publishing, and review. It should feel product-native, not decorative.

### Theme and palette

The system is light-first with true-white product surfaces, deep ink typography, one midnight-blue trust band, high-chroma blue for decisions, cyan for time and flow, emerald for healthy states, and amber for review.

| Token | Value | Role |
| --- | --- | --- |
| Ink 950 | `#07111F` | Hero type and dark bands |
| Ink 800 | `#16243A` | Secondary dark text |
| Slate 600 | `#526078` | Body copy |
| Slate 300 | `#C9D3E1` | Strong borders |
| Slate 150 | `#E7ECF3` | Hairlines |
| Cloud 050 | `#F5F7FA` | Cool page band |
| White | `#FFFFFF` | Primary canvas and product surfaces |
| Lineup Blue | `#2F63FF` | Primary actions and selected state |
| Electric Blue | `#4F79FF` | Brand-mark gradient bridge |
| Shift Cyan | `#22B8CF` | Time, flow, and secondary emphasis |
| Ready Green | `#17A765` | Complete, covered, delivered |
| Review Amber | `#D99019` | Needs attention or review |
| Alert Rose | `#D94A64` | Destructive or failed state only |

For small semantic text on light surfaces, use the accessible companion shades Ready Green `#087849`, Review Amber `#815200`, and Alert Rose `#B22945`. The brighter base colors remain available for icons, rails, borders, and larger graphical states.

The brand gradient is `#2F63FF` to `#4F79FF` to `#22B8CF`. Use it sparingly on the mark, primary button highlight, or one schedule rail. Never wash a whole page or hero image with it.

### Typography, geometry, and depth

- Primary family: `Inter Variable`, `Segoe UI Variable`, or the closest installed neutral grotesk.
- Display: 700-780 weight, compact tracking, 0.98-1.06 line height.
- Body: 400-500 weight, 1.55-1.7 line height, maximum 62-character measure.
- UI chrome: 600-700 weight at 12-14px; never browser-default typography.
- Standard controls use 10-12px radii; product frames use 20-24px.
- Status indicators may use pills because state is their function.
- Avoid giant rounded wrappers, nested cards, and default bento grids.
- Use cool one-pixel borders and one strong hero elevation; downstream surfaces stay flatter.

### Iconography, imagery, and motion

- Keep the existing LunchLineup calendar/line mark.
- Use Lucide icons only where they clarify an action or concept; avoid decorative icon rows.
- Product UI is the primary imagery. The schedule itself is the hero artwork.
- Future photography should show real shift-work environments with documentary lighting, never generic office stock or empty restaurant interiors.
- Use 160-240ms control transitions and 420-650ms product-story transitions.
- Motion may move a shift through Plan -> Publish -> Notify -> Review or change the active role view.
- No perpetual marquees, scroll hijacking, floating particles, or motion without a static reduced-motion equivalent.

## 5. Homepage story

### 1. Navigation and hero

- Quiet navigation: Product, How it works, Security, Sign in, and one beta action.
- H1: **The schedule, already thinking ahead.**
- Deck: **Build the week with availability, breaks, coverage, and time review in one clear flow.**
- A code-native schedule canvas is the dominant visual.
- Proof notes: Availability in view; Breaks planned; Coverage visible.

### 2. One schedule, three perspectives

An interactive switcher changes the supporting view while preserving one shared week:

- Manager: build, edit, and publish.
- Operator: see locations, coverage, and review status.
- Team member: understand the shift, lunch, break, and published state.

### 3. The operating flow

Use one connected lifecycle: Plan availability and demand -> Build and adjust -> Publish with review -> Notify with delivery state -> Review time cards and payroll-ready records.

### 4. Operational depth

Use an open editorial layout, not a feature-card grid, to explain staff profiles and availability, location-aware scheduling, lunches and breaks, time cards and corrections, payroll-period review and reconciliation, and roles and permissions.

### 5. Trust band

Use measured beta language: tenant-scoped workspaces, role-based access, MFA and OTP support, and audit-minded sensitive actions. Link to `/security`; never promise absolute security or undocumented certification.

### 6. Final action and footer

- Closing line: **A clearer week starts with the schedule.**
- The primary action follows configured signup mode.
- Footer retains Status, Privacy, Terms, Security, and Subprocessors.

## 6. SaaS benchmark blend

The design borrows patterns, never layouts or claims.

| Source | Useful pattern | LunchLineup translation |
| --- | --- | --- |
| [Linear](https://linear.app/) | Product UI as artwork; chaptered workflow | Make the real schedule the hero and use a numbered flow |
| [Notion](https://www.notion.com/product) | Editorial whitespace and calm outcome headline | Keep opening copy short and let one product frame carry detail |
| [Slack](https://slack.com/) | Multiple work perspectives | Switch one schedule among manager, operator, and team views |
| [Rippling](https://www.rippling.com/en-GB/workforce-management) | Connected people, time, and workflow data | Show real links among staff, schedules, and time review |
| [Gusto](https://gusto.com/) | Human warmth and step-by-step explanation | Use approachable language and an understandable sequence |
| [Deputy](https://www.deputy.com/) | Shift-work specificity and product modules | Make hourly-work context immediate while keeping claims exact |
| [Homebase](https://www.joinhomebase.com/) | Punchy headline and decisive CTA | Use one memorable promise and one beta action |
| [7shifts](https://www.7shifts.com/) | Restaurant-native lifecycle storytelling | Preserve restaurant credibility and use the shipped workflow |
| [When I Work](https://wheniwork.com/) | Mobile-first utility and product proof | Keep explanation practical and responsive |
| [Toast](https://pos.toasttab.com/) | Bold operational category presence | Bring shift-floor energy without borrowing scale or AI claims |

Best composite: 7shifts category fluency + Linear product fidelity + Slack perspective switching + Gusto warmth + Homebase CTA discipline.

## 7. Accessibility and responsive behavior

- Meet WCAG AA contrast and never rely on color alone for state.
- Role and workflow controls must be keyboard reachable and expose selected state.
- Tablet may stack hero copy above the product frame.
- Mobile keeps the H1, primary action, and useful schedule slice in the first two viewports.
- Dense schedule content may scroll within a labeled region; the page must not overflow.
- Use 44px interactive targets where practical and honor `prefers-reduced-motion`.

## 8. Implementation and governance

- Keep homepage controls and visible product text code-native.
- Keep signup-mode gating intact; never render a dead onboarding CTA.
- Reuse the existing mark and the application's Lucide and Framer Motion stack.
- Use a scoped CSS module; do not grow global CSS with route-specific composition.
- Reuse components for buttons, schedule rows, states, tabs, and workflow steps.
- Preserve public legal and trust routes.
- Add no customer proof or product claim without verified source material.
- Review the page for one clear CTA, varied section rhythm, mobile credibility, and a schedule that is unmistakably the product.

This file owns public brand and homepage direction. `docs/saas-ui-overhaul.md` remains the application UI reference, while `docs/compliance/privacy-security.md` remains the source of truth for public privacy and security commitments. If copy conflicts, product and compliance truth win over marketing tone.
