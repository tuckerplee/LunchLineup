# LunchLineup

LunchLineup (https://lunchlineup.com) is an all-in-one PHP and JavaScript application for managing daily employee schedules. The project avoids build steps and uses a lightweight MySQL database so it can run on any web server with PHP. Bootstrap 5 is loaded from a CDN to provide basic component styling without adding a heavy toolchain.

## Table of Contents
- [Core Features](#core-features)
- [Directory Structure](#directory-structure)
- [Getting Started](#getting-started)
- [API Overview](#api-overview)
- [Admin Workflow](#admin-workflow)
- [Data Files](#data-files)
- [Development Notes](#development-notes)
- [Customisation Guide](#customisation-guide)

## Core Features
- Interactive table interface for creating shifts, breaks and tasks
- Persistent schedule data stored in a MySQL database
- REST‑like PHP API powering the JavaScript front end
- JWT authentication with login via email and password, with temporary lockout after repeated failures
- Print‑friendly schedule view with automatic print dialog, aligned tip tracker, and layout that auto-scales to fit a single page
- Optional PDF export of the print view powered by the bundled Dompdf library
- All schedule, staff and chore data saved to the MySQL database with no browser local storage
- Assign preferred POS numbers and tasks for each staff member
- Import schedules directly from PDFs
- Load reusable schedule templates
- Configurable break policy per store (max concurrent breaks, minimum spacing and lunch window)
- Coordinated break scheduling that maintains minimum floor coverage
- Drag-and-drop rule library with a visual drop zone outlining each rule's behavior

## Folder Overview

## Directory Structure
- **public/** – Web-accessible files
  - **assets/** – Static front‑end resources
    - **css/** – `base.css`, `scheduler.css`, `print.css`, the Dompdf-focused `bootstrap_print_subset.css`, and optional `tailwind.css`; Bootstrap is included via CDN for additional UI polish
    - **js/**  – `main.js` plus modules handling UI state and events
    - **templates/** – email templates for outgoing messages
  - **api/** – PHP endpoints that expose the scheduler data
  - **admin-api/** – Company admin endpoints used by the admin dashboard
- **superadmin-api/** – Additional system-wide endpoints for super admins
  - **admin/** – Store, user, role and settings management interface including audit logs and reporting
  - **superadmin/** – Global dashboard for system-wide tasks like company management
  - `index.php`, `app.php`, `login.php`, `logout.php` and `setup.php`
- **src/** – PHP helper library and reusable view templates
  - **views/** – HTML snippets such as modal dialogs
- **scripts/** – Utility scripts such as the setup and migration tools
- **tests/** – Simple PHP test scripts

Every folder contains its own README with additional detail about the files inside. The root README summarises all of them for quick reference.

The invitation API (`api/invitations.php`) now powers the Company Admin Portal workflow for inviting users from the Store management screen (`public/admin/store.php`). Backups can be created, restored or deleted by super admins via `superadmin-api/backup.php` with a required `company_id` parameter. Command line scripts `scripts/backup.php` and `scripts/restore.php` offer matching backup and restore functionality. These scripts decrypt database fields that use the application `APP_KEY` and re‑encrypt them with the provided password so a restore on a new instance does not require the original key.
Encrypted backup files are saved to the `public/backups/` directory and require the password used to create them.

## Getting Started
1. Install PHP 7.4 or later and ensure the `pdftotext` command is available for PDF schedule imports. A MySQL server is also required. PDF or text uploads over 5 MB are rejected. The print-to-PDF endpoint uses the bundled Dompdf library located in `scripts/dompdf`, so enable its PHP dependencies (`mbstring`, `gd`) on the server.
2. Clone this repository:
   ```bash
   git clone <repo-url>
   cd scheduler
   ```
3. Run the setup wizard to generate a `.env` file with database credentials and encryption keys. The wizard verifies the file was written and prints its path for troubleshooting. If you prefer manual configuration, create a `.env` file in the project root:
    ```env
    DB_HOST=localhost
    DB_NAME=scheduler
    DB_USER=root
    DB_PASS=your_db_password
    JWT_SECRET=your_jwt_secret
    APP_KEY=your_app_key
    BACKUP_DIR=public/backups  # default path for encrypted backups
    ```
    To generate secure values for the secrets manually:
    ```bash
    JWT_SECRET=$(php -r 'echo bin2hex(random_bytes(32));')
    APP_KEY=$(php -r 'echo base64_encode(random_bytes(32));')
    ```
   The included `config.php` parses `.env` and exposes values via `getenv()`/`$_ENV`. The `APP_KEY` supplies a 256-bit key for `src/crypto.php` and must be 32 random bytes encoded with base64 as shown above.
4. Start the built‑in PHP server from the project root, pointing it at the `public` directory:
   ```bash
   php -S localhost:8000 -t public
   ```
5. Visit [http://localhost:8000](http://localhost:8000) to view the landing page. If `config.php` is missing you will be redirected to the setup form where you can enter MySQL credentials. The wizard verifies the connection, checks for existing tables, and lets you keep or overwrite any current data. Choosing overwrite drops existing tables before importing any selected JSON or CSV files, ensuring a clean install. The form also lets you specify optional company and store names and the first admin's name, email and password so you can log in straight away; this initial account is granted super admin privileges and can manage any company.
6. Sign in at `/login.php` with the admin email and password you provided. If the account is linked to multiple companies you will be asked to choose one after logging in. Super admins are taken to `admin/index.php` to open the super admin dashboard or return to the calendar. Company administrators are redirected to `admin/index.php?company_id=ID` while other users land on `app.php?company_id=ID`.
7. Visit `/admin/index.php?company_id=ID` with an administrator account to manage stores, users, roles, settings and automation. If no store exists yet, you'll be prompted to add one before using the scheduler.
8. Begin editing the schedule. Use the Logout button to end your session.

Any changes are saved to the configured MySQL database. The setup script imports existing CSV and JSON data. The default column headers are still defined in `src/data/schedule.php` under the `SCHEDULER_HEADERS` constant.

## API Overview
Authenticate by POSTing `{ "email": "user@example.com", "password": "..." }`
to `api/auth.php`. Accounts are locked for 15 minutes after five failed attempts from the same IP. The response includes a JWT `token` plus an `isSuperAdmin` flag (and `isCompanyAdmin` when applicable) to help client-side routing. Tokens remain valid for two hours before expiring. All user-supplied text fields in responses are HTML-escaped. Include the returned `token` with each request and provide the `company_id` for all admin endpoints, adding the `store_id` when addressing a specific store. Staff and user listings omit company administrators by default. Add `admins=true` to `api/users.php` (or `admins=false` to keep the default) or `includeAdmins=true` to `api/staff.php` when you need to manage or audit admin accounts. Otherwise, leave these flags off to keep admins out of results. If permissions change, you can refresh the token with `GET api/auth.php`; the front end automatically does this when a request receives a `403` response.

All URL parameters now use snake_case (for example, `company_id` and `store_id`). CamelCase versions such as `companyId` are still accepted for backward compatibility, but the server emits an `X-Deprecation-Warning` header when they are used.

API responses that return user rosters enforce `Cache-Control: no-store, no-cache, must-revalidate` today. This header is sent by `api/users.php`, `api/staff.php`, and the matching `admin-api/users.php` endpoint to prevent browsers from storing sensitive personnel data. Other endpoints currently rely on default PHP caching behaviour.

Paginated endpoints default to the `DEFAULT_PAGE_SIZE` (10) results per page. Adjust `src/config.php` to change this value.

 Example:
```
GET    api/schedule.php?token=TOKEN&company_id=COMPANY&store_id=STORE        # fetch schedule data
GET    api/print_schedule.php?token=TOKEN&company_id=COMPANY&store_id=STORE[&date=YYYY-MM-DD][&format=pdf] # print schedule (HTML by default, PDF when format=pdf)
POST   api/schedule.php?token=TOKEN&company_id=COMPANY&store_id=STORE        # save schedule data
POST   api/breaks.php?token=TOKEN&company_id=COMPANY&store_id=STORE         # calculate break times for a shift
GET    api/users.php?token=TOKEN&company_id=COMPANY&admins=true               # list users including admins (admin only)
GET    api/staff.php?token=TOKEN&company_id=COMPANY&store_id=STORE            # list staff members (schedule or staff role)
GET    api/staff.php?token=TOKEN&company_id=COMPANY&store_id=STORE&includeAdmins=true # include admins in staff results (schedule or staff role)
POST   api/staff.php?token=TOKEN&company_id=COMPANY&store_id=STORE           # replace staff list (staff or schedule role)
GET    api/chores.php?token=TOKEN&company_id=COMPANY&store_id=STORE          # list chores
POST   api/chores.php?token=TOKEN&company_id=COMPANY&store_id=STORE          # create or update a chore
DELETE api/chores.php?id=ID&token=TOKEN&company_id=COMPANY&store_id=STORE    # remove a chore by id
GET    api/templates.php?token=TOKEN&company_id=COMPANY                      # list schedule templates
POST   api/templates.php?token=TOKEN&company_id=COMPANY                      # create or update a template (admin only)
DELETE api/templates.php?id=ID&token=TOKEN&company_id=COMPANY                # delete a template (admin only)
GET    admin-api/templates.php?token=TOKEN&company_id=COMPANY                # list automation templates
POST   admin-api/templates.php?token=TOKEN&company_id=COMPANY                # create or update an automation template (admin only)
DELETE admin-api/templates.php?id=ID&token=TOKEN&company_id=COMPANY          # delete an automation template (admin only)
GET    api/metrics.php?token=TOKEN&company_id=COMPANY&timeframe=week|month    # aggregated shifts and chores (admin only)
GET    api/companies.php?token=TOKEN                     # list companies (super admin only)
POST   api/companies.php?token=TOKEN                     # create or update a company (super admin only)
DELETE api/companies.php?id=ID&token=TOKEN               # delete a company (super admin only; fails if it has related data)
GET    api/stores.php?token=TOKEN&company_id=COMPANY[&search=TERM&page=N]    # list stores (admin only)
POST   api/stores.php?token=TOKEN&company_id=COMPANY                         # create or update a store
DELETE api/stores.php?id=ID&token=TOKEN&company_id=COMPANY                   # delete a store (admin only)
GET    api/users.php?token=TOKEN&company_id=COMPANY[&search=TERM&page=N]     # list users (admin only)
POST   api/users.php?token=TOKEN&company_id=COMPANY                         # create or update a user (body requires homeStoreId and storeIds[] within the company; optional isAdmin flag and roles[] or {role:true} like staff, schedule or chores; omitting isAdmin or roles[] keeps existing values)
DELETE api/users.php?id=ID&token=TOKEN&company_id=COMPANY                   # delete a user (admin only)
GET    api/settings.php?token=TOKEN&company_id=COMPANY&name=NAME[&store_id=STORE] # fetch a setting
POST   api/settings.php?token=TOKEN&company_id=COMPANY                                                # create or update a setting (admin only)
POST   api/invitations.php?token=TOKEN&company_id=COMPANY                    # invite a user by email (used by admin Store screen)
POST   api/reset_request.php                              # send a password reset email
POST   api/reset_password.php                             # reset password using a token
POST   api/import_pdf.php?token=TOKEN&company_id=COMPANY&store_id=STORE      # upload PDF and return parsed schedule
POST   api/parse_schedule.php?token=TOKEN&company_id=COMPANY                 # parse schedule text (send as text/plain) and return JSON
GET    api/parse_schedule.php?debug                       # debug form for uploading PDF or text (debug mode)
GET    api/parse_schedule.php?debug=TEXT                  # parse TEXT directly (debug mode)
GET    api/bulk_export.php?token=TOKEN&type=TYPE&format=csv|json # export stores, users or staff (admin only)
POST   api/bulk_import.php?token=TOKEN&company_id=COMPANY&type=TYPE           # import stores, users or staff (admin only)
```

### Chore template metadata

Chores are now stored as configurable templates rather than plain text rows so
the auto-assignment workflow can make smarter choices when staffing is tight.
The `chores` table keeps the original `assigned_to` column for backward
compatibility and layers in richer metadata:

- **name / instructions / is_active** – user-facing label, optional extra
  guidance, and an archive toggle for templates that should disappear without
  being deleted.
- **priority / auto_assign_enabled** – numeric weight for ordering chores and a
  flag that marks chores which must always be placed manually.
- **frequency / recurrence_interval / active_days** – recurrence rules that
  describe how often a template should appear.
- **window_start / window_end / daypart / exclude_closer / exclude_opener /
  lead_time_minutes / deadline_time** – controls for time-of-day eligibility,
  including shortcuts for “don’t assign to closers” and “don’t assign to
  openers”.
- **allow_multiple_assignees / max_per_day / max_per_shift /
  max_per_employee_per_day / min_staff_level** – guardrails that cap how often
  a template is scheduled and the staffing levels required before it can be
  assigned.
- **estimated_duration_minutes** – workload metadata so managers can balance
  labor when planning.
- **created_by / created_at / updated_at** – lightweight auditing for template
  changes.

Future backend work will expose these fields through the API so the browser can
round-trip template settings without relying on local-only state.

Super admins can use the standard `api/` endpoints to manage companies, stores, and users across organizations. Additional maintenance endpoints remain under `superadmin-api/`:

```
GET    superadmin-api/logs.php?token=TOKEN&company_id=COMPANY[&user_id=ID][&action=ACTION][&page=N] # view audit logs
GET    superadmin-api/staff.php?token=TOKEN[&company_id=COMPANY][&search=TERM&page=N][&includeAdmins=true] # list staff members
POST   superadmin-api/staff.php?token=TOKEN                      # create or update a staff member (body requires companyId and optional storeId)
DELETE superadmin-api/staff.php?id=ID&token=TOKEN                # remove a staff member by id
POST   superadmin-api/backup.php?action=backup&token=TOKEN&company_id=ID      # create encrypted database backup
POST   superadmin-api/backup.php?action=restore&token=TOKEN&company_id=ID     # restore database from uploaded file
POST   superadmin-api/backup.php?action=delete&token=TOKEN&company_id=ID      # delete backup file (body: file=PATH)
```

Audit logs capture schedule events such as saving, modifying, clearing and printing.

Run database upgrades through the coordinator instead of `superadmin-api/schema.php`:

- Browser: visit `/update.php`, sign in with a super-admin account, and apply any pending scripts.
- CLI: execute `php scripts/upgrade.php` from the project root on the web server.

## CSRF Protection
Forms include a hidden `csrf_token` tied to the current session. API endpoints validate this token on `POST`, `PUT`, and `DELETE` requests and respond with HTTP 403 if the token is missing or does not match. Requests that supply a JWT via the `token` query parameter or an `Authorization` header bypass this check.


After uploading a PDF schedule from the interface, `import_pdf.php` converts and parses the file in one step. An inline popup lets you choose which days to import, and the selected days are sent to the server for storage.
When debug mode is enabled, visiting the endpoint with `?debug` shows a simple form where you can upload a PDF or text file and see the raw JSON response. Debug access requires an administrator token or a request from an allow‑listed IP address.
The returned JSON includes each date key containing an `employees` array.
Each employee entry now includes a `breaks` array with objects like `{ "start": "10:30 AM", "duration": 10 }`.
Legacy `break1`, `lunch` and `break2` fields are deprecated; they are accepted on save for backward compatibility but are not returned by the API.
Entries with positions beginning with `INV RET` or exactly `TIME OFF VAC` are excluded from the parsed results. Any employee whose shift is `All Day` is also skipped.

## Admin Workflow
1. Visit `/admin/company_dashboard.php` with an administrator account.
2. Use the dashboard to add, edit or delete stores, user accounts, settings, automation rules, run reports and view audit logs. Company administrators can manage custom roles but the built-in `super_admin` role is hidden and cannot be modified.
3. On a store page, you can still invite users by entering their email address and selecting a role. Administrators may also assign existing users to stores directly from the user edit page.

### Super Admin Staff Management
Super admins manage workers who do not require login accounts through the Staff card in the Super Admin portal. The card prompts for a company and opens a modal where they can add or edit staff records without creating user accounts.
Super admins can also run the project's test scripts from the Tests card.

## Data Files
- **config.php** – Loads database credentials, debug settings, and encryption keys from environment variables, parsing `.env` if present
- **.env** – Environment variables for database access and encryption keys generated by the setup script
- **data.csv** – legacy CSV schedule (optional, used by migration)
- **stores.json** – list of stores with `name` and `location` (migration source)
- **user_store_roles.json** – mappings of user/store assignments and roles (migration source)

Staff data lives in the database and should be managed through the app's UI or migration scripts rather than editing a JSON file.

Changing the `JWT_SECRET` value in `.env` or the environment invalidates existing tokens and forces new logins.

## Development Notes
- Review [docs/user_staff_architecture.md](docs/user_staff_architecture.md) before changing user or staff code
- JavaScript modules live under `public/assets/js/modules`
- Stylesheets reside in `public/assets/css`
- No build step is required; simply edit the files and reload the browser
 - Maintenance scripts run from the command line must also be reachable from the web interface; `superadmin/backup.php` uses the same functions as `scripts/backup.php` and `scripts/restore.php`.
- `pdftotext` is called by `api/import_pdf.php` and `api/parse_schedule.php` for PDF conversion; both endpoints enforce a 5 MB upload limit
- `public/.htaccess` protects sensitive files from direct access

## Database Setup

The application requires a JWT secret provided via the `JWT_SECRET` environment variable. The setup wizard generates this automatically.

The installer defaults to a database named `schedule_db`.

1. Visit the app in a browser and complete the setup form. If the database already contains scheduler tables you can choose to reuse them or overwrite; overwriting drops existing tables and then imports any selected JSON or CSV files.
2. To inspect the database, use the MySQL CLI:
   ```bash
   mysql -u USER -p -h HOST DBNAME -e "SELECT * FROM staff;"
   ```

3. If upgrading an existing install, add the JSON `breaks` column and migrate legacy break fields:
   ```bash
   php scripts/migrate_breaks.php
   ```

4. User emails are stored encrypted with a matching `emailHash` column for case-insensitive lookups. Existing installs should run the upgrade helper to add the column and backfill hashes:
   ```bash
   php scripts/upgrade.php email-hash
   ```


## Manual Testing
Automated regression scripts under `tests/` guard against admins appearing in staff lists or schedules. `staff_admin_filter_test.php` and `users_api_admin_filter_test.php` confirm listings exclude admins unless explicitly requested, while `staff_admin_reject_test.php` and `schedule_admin_reject_test.php` ensure admin accounts cannot be added to staff or placed on schedules.

To test the schedule parser locally, set `DEBUG=true` in `.env` and ensure your IP is allow‑listed:

```bash
php -S localhost:8000
```

Visit [http://localhost:8000/api/parse_schedule.php?debug](http://localhost:8000/api/parse_schedule.php?debug)
and upload a PDF or paste text. Submitting the form returns the parsed JSON so you can inspect the output.

### Verify company scoping for user management
1. Start the server with `php -S localhost:8000 -t public` and sign in as a super admin.
2. Open `/admin/user.php` and choose a company. Developer tools should show all requests to `api/users.php` include the `company_id`.
3. Edit or create a user and attempt to assign a store from another company. The API will ignore stores outside the selected company.
4. Change the `company_id` in the query string to another company and confirm that only that company's users and stores are returned.

### End-to-End Setup Routine
1. Start a MySQL or MariaDB server and ensure no `config.php` file exists.
2. Launch the app with `php -S localhost:8000 -t public` and open `http://localhost:8000/index.php` in a browser.
3. Follow the setup wizard, enter database credentials, and create the Super Admin account.
4. After setup, return to the landing page, click **Log In**, and sign in with the Super Admin.
5. Under **Companies**, click **Open**, create a new company, then choose **manage** and add a store. Confirm you return to the Manage Company page.
6. From the Manage Company page, add a user for the new company and verify the page reloads.
7. Log out, sign in as the new user, navigate to **Staff**, click **add staff**, create a staff member, and save.

## Customisation Guide
The project is intentionally lightweight so you can modify it to suit your own workplace. Common customisations include:
- Editing the files in `public/assets/css/` for branding or layout tweaks
- Adjusting table headers in `src/data/schedule.php`
- Adding new fields to schedule records in the database
- Extending the API endpoints in the `public/api` directory

For a deeper dive into any folder, consult the README located within that folder.

