# User and Staff Architecture

This document outlines how user and staff data flows through LunchLineup.
It highlights the repositories responsible for database access and the services
that coordinate higher‑level operations.

## Repositories

- **`src/data/users.php`** – Functions for fetching, saving, and deleting users,
  managing invitations, and handling password resets. This layer owns all direct
  access to the `users`, `user_store_roles`, and related tables, and now
  maintains an `emailHash` column for case-insensitive email lookups.
- **`src/data/staff.php`** – The `StaffRepository` class and helper functions for
  listing and persisting staff records. It enforces rules such as rejecting admin
  accounts in staff lists and normalises optional fields like tasks or preferred
  registers.

## Services

- **`src/UserService.php`** – Wraps user persistence and role assignment. It
  coordinates `saveUser()` with store roles, normalises role input, and toggles
  admin status by calling the `StaffService`.
- **`src/StaffService.php`** – Thin service around the staff repository. It
  saves individual staff members and updates the `is_admin` flag while letting
  `StaffRepository` handle low‑level SQL details.

## Responsibilities

The repositories are solely responsible for database interaction. Services build
on them to provide higher‑level actions used by API endpoints and UI flows. All
code that creates or updates users or staff should go through these services so
that:

1. Admin flags stay in sync between user and staff records.
2. Store role assignments remain consistent across companies and stores.
3. Data access is centralised, easing future schema changes.

Following this separation keeps business logic out of controllers and reduces the
risk of user and staff behaviour diverging over time.
