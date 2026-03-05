# Data Modules

This directory contains modular pieces of the data-access layer.
Each file groups related functions that were previously bundled in `src/data.php`:

- `core.php` – configuration, database helpers, and audit logging.
- `staff.php` – staff records and admin checks; listing helpers accept an `$includeAdmins` flag to return administrators.
- `schedule.php` – schedule operations and templates, including `SCHEDULER_HEADERS`.
- `chores.php` – chore management.
- `stores.php` – stores and companies.
- `roles.php` – role definitions and assignments.
- `users.php` – user accounts and invitations (invitation helpers remain unused by the current admin portal) with optional admin filtering.
- `settings.php` – application and break settings.
- `jwt.php` – token helpers.

Include `src/data.php` to load all modules at once for backwards compatibility.
