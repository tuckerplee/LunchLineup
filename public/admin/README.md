# Admin Interface

Admin pages for managing companies, stores, users, roles, settings and automation. Super admins can access every company's dashboard, while company admins are limited to their own companies. Run `php scripts/migrate_companies.php` when upgrading to create the default company and assign a company admin.

Pages primarily call company-scoped endpoints under `../api/` so company administrators can manage their own data. Super admins may also access system-wide endpoints via `../admin-api/`.
Modal dialogs fetch page content dynamically rather than embedding iframes, keeping dashboards isolated.

Architectural details for the user and staff layers are documented in [docs/user_staff_architecture.md](../../docs/user_staff_architecture.md).

- **index.php** – Landing page listing companies available to the current admin. Super admins instead see links to the Super Admin dashboard and the scheduler calendar.
- **company_dashboard.php** – Card-based dashboard with modal action cards for automation settings, stores, users, settings, reporting and audit logging. Each card opens a modal that first prompts for a store, mirroring the Super Admin flow. Lists stores and users with search and pagination, includes metrics charts powered by Chart.js, and provides a link back to the main scheduler. Requires a `company_id` query parameter and verifies the user is a company admin or super admin.
- **company.php** – List, create, edit or delete companies (super admin only).
- **store.php** – Form for creating or updating stores and inviting users by email with a role.
- **user.php** – Form for creating or updating user accounts, assigning them to stores and roles, viewing lock status and sending reset emails. Super admins may manage any company; company admins are limited to their own company via a `company_id` query parameter.
- **staff.php** – Form for creating or updating staff profiles. Company admins can manage staff for their own company using a `company_id` query parameter.
- **roles.php** – Create, edit or delete roles and their permissions.
- **automation.php** – Drag-and-drop interface with a rule library and drop zone that displays rule descriptions for creating, editing and ordering automation rules. Templates are saved per company via `admin-api/templates.php`.
- **settings.php** – Configure company or store-specific settings including break limits (max concurrent breaks, minimum spacing and lunch window).
- **reporting.php** – Placeholder for future reporting tools.
- **audit.php** – View audit logs with filtering options. Logs are fetched via the admin API and support pagination.
- **select_store.php** – Inline modal store selector used by dashboard cards to open store-scoped pages.

The `admin-api/invitations.php` endpoint remains in the codebase for compatibility but is not used by this dashboard.

## Bulk Import/Export Formats

`bulk_import.php` and `bulk_export.php` support the following fields:

### Stores
- `id` (optional)
- `name`
- `location` (optional)

### Users
- `id` (optional)
- `email`
- `homeStoreId`
- `name` (optional)
- `isAdmin` (0 or 1)

### Staff
- `id` (optional)
- `storeId`
- `name`
- `lunchDuration` (minutes)
- `isAdmin` (0 or 1)

