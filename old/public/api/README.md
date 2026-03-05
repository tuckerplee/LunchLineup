# API Documentation

The LunchLineup API exposes simple PHP endpoints for reading and writing the
MySQL-backed schedule data used by the application. Clients authenticate by
POSTing credentials to `auth.php` to receive a signed JWT token. Browser
clients also receive this token as a secure, HTTP-only cookie. Include this
`token` parameter with each request along with any required `company_id` and
`store_id`. Requests without valid credentials return **403 Forbidden**. If a
token becomes outdated—for example, after changing store assignments—clients
may call `GET auth.php` to refresh it.

Endpoints that accept JSON require the `Content-Type: application/json` header.
Invalid JSON bodies return **400 Bad Request**.

Base URL: `http://localhost:8000/api/`

Endpoints that return user listings enforce `Cache-Control: no-store, no-cache, must-revalidate` today. This header is set by `users.php`, `staff.php`, and `../admin-api/users.php` to keep roster data out of browser caches. Other endpoints currently rely on the default caching behaviour provided by PHP.

For an overview of how user and staff repositories interact with these endpoints,
see [docs/user_staff_architecture.md](../../docs/user_staff_architecture.md).

## Endpoints

| Method | Path | Description | Parameters |
| ------ | ---- | ----------- | ---------- |
| `POST` | `auth.php` | Exchange email and password for a JWT token. Accounts lock for 15 minutes after five failed attempts from the same IP. | *(email, password in JSON body)* |
| `GET`  | `auth.php` | Refresh the current JWT token using the `token` cookie. | none |
| `GET`  | `schedule.php` | Download schedule data. | `token`, `company_id`, `store_id` |
| `POST` | `schedule.php` | Save schedule data. Admin staff are rejected. | `token`, `company_id`, `store_id` |
| `POST` | `breaks.php` | Calculate optimal break times for a shift. | `token`, `company_id`, `store_id` |
| `POST` | `group_breaks.php` | Schedule coordinated breaks for multiple employees. Employee objects may include `lunchDuration` (minutes) to override the policy. | `token`, `company_id`, `store_id` |
| `GET`  | `staff.php` | List staff members (schedule or staff role). Admins are always excluded. | `token`, `company_id`, `store_id` |
| `POST` | `staff.php` | Replace staff list (staff or schedule role). Entries marked as admins are rejected. | `token`, `company_id`, `store_id` |
| `GET`  | `chores.php` | List all chores. | `token`, `company_id`, `store_id` |
| `POST` | `chores.php` | Create or update chores. Templates now include metadata fields such as `name`, `priority`, `frequency`, `active_days`, `window_start`, `window_end`, `exclude_closer`, `exclude_opener`, `max_per_day`, and `estimated_duration_minutes`. | `token`, `company_id`, `store_id` |
| `DELETE` | `chores.php` | Remove a chore by id. | `token`, `id`, `company_id`, `store_id` |
| `GET`  | `templates.php` | List schedule templates. | `token`, `company_id` |
| `POST` | `templates.php` | Create or update a template (admin only). | `token`, `company_id` |
| `DELETE` | `templates.php` | Delete a template by id (admin only). | `token`, `id`, `company_id` |
| `GET`  | `metrics.php` | Aggregate shift and chore counts (admin only). | `token`, `company_id`, `timeframe=week|month`? |
| `GET`  | `companies.php` | List companies (super admin only). | `token` |
| `POST` | `companies.php` | Create or update a company (super admin only). | `token` |
| `DELETE` | `companies.php` | Delete a company (super admin only; fails if it has related data). | `token`, `id` |
| `GET`  | `stores.php` | List stores (admin only). Supports `search` and `page`. | `token`, `company_id`, `search`?, `page`? |
| `POST` | `stores.php` | Create or update a store (admin only). | `token`, `company_id` |
| `DELETE` | `stores.php` | Delete a store (admin only). | `token`, `id`, `company_id` |
| `GET`  | `users.php` | List users (admin only). Supports `search`, `page` and `admins=true|false` to filter admins; non-admins are returned by default. | `token`, `company_id`, `search`?, `page`?, `admins`? |
| `POST` | `users.php` | Create or update a user (admin only). Body requires `homeStoreId`, `storeIds[]`, optional `isAdmin` and `roles[]` such as `staff`, `schedule`, or `chores`; omitting `isAdmin` or `roles[]` keeps existing values. | `token`, `company_id` |
| `DELETE` | `users.php` | Delete a user (admin only). | `token`, `id`, `company_id` |
| `GET`  | `settings.php` | Retrieve a setting value. | `token`, `company_id`, `name`, `store_id`? |
| `POST` | `settings.php` | Create or update a setting (admin only). | `token`, `company_id` |
| `POST` | `invitations.php` | Invite a user to a store and assign a role (admin only; used by the admin Store screen). | `token`, `company_id` |
| `POST` | `reset_request.php` | Send a password reset email. | *(email in JSON body)* |
| `POST` | `reset_password.php` | Reset a user's password using a token. | *(token, password in JSON body)* |
| `GET`  | `print_schedule.php` | HTML print view of the schedule and chore list. Uses `assets/css/print.css` and `assets/js/print.js`. | `token`, `company_id`, `store_id`, `date` |
| `POST` | `import_pdf.php` | Upload a PDF (max 5 MB) and return parsed schedule. | `token`, `company_id`, `store_id`, `pdf` |
| `POST` | `parse_schedule.php` | Parse schedule text posted as `text/plain` and return JSON. | `token`, `company_id` |
| `GET`  | `parse_schedule.php?debug=TEXT` | Parse `TEXT` directly (debug mode). | admin token or allow‑listed IP |
| `GET`  | `bulk_export.php` | Download staff, user or store data as CSV or JSON (admin only). | `token`, `type`, `format=csv|json` |
| `POST` | `bulk_import.php` | Upload staff, user or store data as CSV or JSON (max 5 MB, admin only). | `token`, `company_id`, `type`, `file` |

All responses are JSON except for `print_schedule.php`, which returns HTML for
direct viewing in a browser.

When debug mode is enabled, visiting `parse_schedule.php?debug` in a browser opens a small form where you can upload a PDF schedule or paste plain text. Submitting the form requires an administrator token or an allow‑listed IP address and returns the parsed JSON.

Non-`2xx` status codes indicate errors. See the HTTP response body for details.
# API Directory

This folder contains the PHP endpoints used by the front-end JavaScript. All endpoints expect a `token` parameter obtained from `auth.php`.

## Files

- **auth.php** – Validates user credentials and returns a signed JWT token. Accounts lock for 15 minutes after five failed attempts from the same IP.
- **schedule.php** – Reads or writes schedule data in the MySQL database. `GET` returns all shifts; `POST` saves JSON.
- **breaks.php** – Calculates optimal break times for a shift based on policy settings.
- **group_breaks.php** – Coordinates break and lunch times for multiple employees. Include `lunchDuration` (minutes) in each employee to override the default.
- **staff.php** – Reads or writes staff records in the MySQL database. `GET` returns staff members excluding company administrators. `POST` replaces the staff list and requires staff or schedule role.
- **templates.php** – CRUD interface for schedule templates stored as JSON payloads.
- **chores.php** – Manages chore templates in the MySQL database. `POST` accepts an array of chores or a single chore and now persists metadata including priorities, recurrence windows, eligibility rules (`chore_allowed_positions`, `chore_excluded_positions`, `chore_required_skills`) and workload estimates. `DELETE` removes a chore by id.
- **metrics.php** – Returns aggregated shift and chore counts for charts.
- **stores.php** – Lists, creates, updates or deletes stores in the database. `GET` supports optional `search` and `page` parameters.
 - **companies.php** – Lists, creates, updates or deletes companies (super admin only; deletion fails if the company has related data).
- **users.php** – Lists, creates, updates or deletes users in the database. `GET` supports optional `search`, `page` and `admins=true|false` parameters; admins are excluded unless `admins=true`. Creating or updating a user requires `homeStoreId` and a non-empty `storeIds` array in the request body; include `roles[]` (e.g. `staff`, `schedule`, `chores`) to grant additional permissions. Omitting `roles[]` preserves current roles.
- **settings.php** – Retrieve or update company or store settings.
- **invitations.php** – Invites users by email and assigns a store role (used by the Company Admin Portal's Store management screen).
- **print_schedule.php** – Validates the token, prepares view data and includes `../../src/views/print_schedule_view.php` to render the HTML. The output includes the schedule, training card, tip tracker and chore list. Static assets live in `../assets/css/print.css` and `../assets/js/print.js`. `GET` with `token`, `company_id`, `store_id` and optional `date`.
- **import_pdf.php** – Upload a PDF (max 5 MB) and receive the parsed schedule. `POST` with `pdf` file.
- **parse_schedule.php** – Parses plain text schedules and returns structured JSON. `POST` with `token` and `company_id`. Add `?debug` when debug mode is enabled for an upload form or to parse text via the query string.
- **bulk_export.php** – Downloads staff, user or store data in CSV or JSON format. `GET` with `token`, `type` and `format`.
- **bulk_import.php** – Imports staff, user or store data from CSV or JSON (max 5 MB). `POST` with `token`, `type` and uploaded `file`.

Use these endpoints from the browser or command line to interact with the schedule data.

