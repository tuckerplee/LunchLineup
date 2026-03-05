# JavaScript Modules

These ES modules are imported by `main.js` and collectively implement the front-end logic.

- **state.js** – Holds global state, loads/saves data from the API.
- **utils.js** – Helper functions such as toast messages.
- **events.js** – Binds DOM event handlers and high level UI interactions.
- **schedule.js** – Rendering and manipulation of the schedule table.
- **modals.js** – Logic for opening and saving the various modal dialogs.
- **break-policy.js** – Shared break policy configuration sourced from the
  server or default templates via `setBreakPolicy`.
- **staff.js** – Functions for managing the employee list.
- **admin-nav.js** – Consistent navigation helpers for admin forms.
- **superadmin-nav.js** – Navigation helpers for super-admin modal pages. Pages using it should set a global `COMPANY_ID` variable (e.g., `window.COMPANY_ID = 123`) when acting on a company so navigation callbacks can return to the correct company.
- **superadmin-staff.js** – Utilities for listing and editing staff on super-admin pages.
- **admin-staff.js** – Utilities for listing and editing staff on company-admin pages.
- **chore-control.js** – Store-level chore template manager used by admin and super-admin portals.

The modules expose global functions and are loaded in `public/app.php` via `<script>` tags.
