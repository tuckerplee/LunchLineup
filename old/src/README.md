# Source Directory

PHP helper functions for reading and writing schedule data along with reusable view templates.

- **config.php** – Shared constants like `DEFAULT_PAGE_SIZE`.
- **data.php** – Provides MySQL database utilities, JWT creation and verification using a secret from the `JWT_SECRET` environment variable or `config.php`, store-scoped query helpers, and functions for managing stores, roles and permissions including `user_has_role()`, `user_has_permission()`, and break policy retrieval via `fetch_break_policy()`. Included by all API endpoints and public pages.
- **auth.php** – Authorization helpers `require_company_admin()` and `require_store_access()` returning JSON 403 responses on failure.
- **print_schedule.php** – Helpers for the printable schedule such as chore loading and time formatting.
- **schedule_parser.php** – Converts plain-text or PDF schedules into structured arrays.
- **breaks.php** – Break scheduling helpers including `calculateBreaks()` for a single shift and `schedule_group_breaks()` for coordinating multiple employees.
- **crypto.php** – Provides `encryptField()` and `decryptField()` helpers using a 256‑bit key from the `APP_KEY` environment variable; `decryptField()` returns the original string when data is not encrypted.
- **views/** – Reusable PHP/HTML snippets like `modals.php` and `print_schedule_view.php`.
- **UserService.php** and **StaffService.php** – Services encapsulating user and staff persistence, role assignment, and admin flag management. See [docs/user_staff_architecture.md](../docs/user_staff_architecture.md) for their design and data flow.
