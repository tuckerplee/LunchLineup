# Tests

Simple PHP scripts verifying project behaviour.

Additional helper endpoints live in the `fixtures` directory.

- `jwt_secret_test.php` – confirms `get_jwt_secret()` returns false when no secret is configured and reads from the environment when provided.
- `sanitization_test.php` – confirms text fields returned by the API escape HTML characters.
- `verify_api_token_test.php` – ensures missing secrets cause token verification to fail gracefully.
- `create_jwt_test.php` – ensures token generation fails gracefully when no secret is configured.
- `store_company_workflow_test.php` – verifies company and store CRUD operations and audit logging.
- `user_store_switch_test.php` – ensures updating a user's home store reassigns store roles.
- `mail_queue_invitation_test.php` – verifies invitation queueing, status transitions, and audit logging.
- `permission_check_test.php` – validates role and permission helpers in `src/data/roles.php`.
- `auth_helper_test.php` – validates authorization helpers in `src/auth.php`.
- `group_breaks_test.php` – checks automated break scheduling for multiple employees.
- `parse_schedule_test.php` – verifies schedule parsing and API edge cases.
- `crypto_test.php` – ensures field encryption round-trips and malformed ciphertext is returned as-is.
- `invalid_json_body_test.php` – ensures endpoints reject malformed JSON payloads.
- `login_lockout_test.php` – verifies login attempts lock the account after 5 failures and reset after a successful login.
- `staff_admin_filter_test.php` – ensures `fetchStaff` excludes admins by default and includes them when requested.
- `user_admin_filter_test.php` – confirms `fetch_company_users` filters admins based on the provided options.
- `users_api_admin_filter_test.php` – verifies `public/api/users.php` excludes admins unless explicitly requested.
- `admin_api_users_admin_filter_test.php` – verifies `public/admin-api/users.php` excludes admins unless explicitly requested.
- `superadmin_staff_admin_filter_test.php` – verifies the super admin staff endpoint respects the `includeAdmins` flag.
- `staff_admin_reject_test.php` – ensures admin users cannot be added to staff lists.
- `schedule_admin_reject_test.php` – ensures admin users cannot be placed on schedules.

## Database bootstrap

Use `tests/util/test_db.php` to create an in-memory SQLite database for tests.
It provides `create_test_db()`, `seed_sample_data()` and `teardown_test_db()` helpers:

```php
require __DIR__ . '/util/test_db.php';

$db  = create_test_db();
$ids = seed_sample_data($db);
// ... run test logic ...
teardown_test_db($db);
```

Run the entire suite with:
```bash
php tests/run_suite.php
```

Pass a substring to run a subset of tests:
```bash
php tests/run_suite.php schedule
```

Super admins can trigger the same suite from **Dashboard → Tests** in the web UI. The page uses `tests/run_suite.php` under the hood, restores the original `config.php` after each script, and supports optional substring filtering from the browser.

If you prefer to execute tests individually you can still run each file directly:
```bash
php tests/jwt_secret_test.php
php tests/sanitization_test.php
php tests/verify_api_token_test.php
php tests/create_jwt_test.php
php tests/store_company_workflow_test.php
php tests/user_store_switch_test.php
php tests/mail_queue_invitation_test.php
php tests/permission_check_test.php
php tests/auth_helper_test.php
php tests/group_breaks_test.php
php tests/parse_schedule_test.php
php tests/crypto_test.php
php tests/login_lockout_test.php
php tests/staff_admin_filter_test.php
php tests/user_admin_filter_test.php
php tests/users_api_admin_filter_test.php
php tests/admin_api_users_admin_filter_test.php
php tests/superadmin_staff_admin_filter_test.php
php tests/staff_admin_reject_test.php
php tests/schedule_admin_reject_test.php
```
