# Super Admin API

Endpoints here are reserved for super administrators and allow system-wide management without referencing the company admin API.

See [docs/user_staff_architecture.md](../../docs/user_staff_architecture.md) for the underlying user and staff service layout.

`companies.php` lists, creates and deletes companies. Deletion fails if the company has related data.

`users.php` manages users across any company. Optional `company_id` scopes results. Creating or updating a user requires `homeStoreId` and a non-empty `storeIds` array in the request body; include `isAdmin` and `roles[]` such as `staff`, `schedule`, or `chores` to grant additional permissions. Omitting `isAdmin` or `roles[]` preserves existing values.

`staff.php` manages staff members across companies. Optional `company_id` scopes results. Set `includeAdmins=true` to include company administrators; otherwise, admin accounts are excluded. The request body must include `companyId` and may include `storeId` when creating or updating staff.

`stores.php` lists and modifies stores for a given `company_id`.

`logs.php` returns audit log entries with the acting user's username, action, company and store names. It requires `company_id` and supports optional `user_id`, `action`, `page` and `per_page` parameters.

Schedule actions recorded in the logs include saving, modifying, clearing and printing.

`reset_request.php` triggers password reset emails for any user.

`backup.php` exposes `POST` actions for `/backup`, `/restore` and `/delete` that call shared PHP functions to dump or restore the database or remove a backup. These functions also power the CLI scripts in `scripts/backup.php` and `scripts/restore.php`. Backup and restore actions stream text responses, require a super admin token, a `company_id`, and a `password` POST parameter. Backups are saved under `public/backups/{company}/{date}/{time}.sql.enc`. An optional `label` query parameter appends `-label` to the timestamp in the filename. A successful backup ends with a line like `DONE {"download": "backup.php?download=PATH&token=TOKEN&company_id=ID"}` where `PATH` is the relative file path. The restore action accepts either an uploaded file (`sql`) or a `file` parameter pointing to a previously saved encrypted dump. The delete action requires a `file` parameter pointing to a saved backup and returns `{ "status": "ok" }` on success.

`schema.php` rebuilds database tables from `scripts/schema.sql`.

`tests.php` runs the PHP test scripts in the `tests/` directory.
