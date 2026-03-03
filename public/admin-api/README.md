# Admin API

Most endpoints in this directory are restricted to super admins and bypass company-level permissions. Some, like `roles.php`, `users.php`, `stores.php`, `metrics.php`, and `audit.php`, also allow company admins when a `company_id` is provided. They mirror the regular API but allow managing any company, store or user across the system.

For background on the services behind these endpoints, see
[docs/user_staff_architecture.md](../../docs/user_staff_architecture.md).

`companies.php` returns all companies with `id`, `name` and a `dashboardUrl` for the admin interface.

The `users.php` endpoint accepts optional `company_id` and `admins` parameters. When `company_id` is provided, it returns only users whose home store belongs to that company and ignores store assignments outside it. Use `admins=true|false` to filter administrators; the default lists non-admin users. Company admins may call this endpoint only with their own `company_id`, while super admins can omit the parameter to list users across every company. Creating or updating a user requires `homeStoreId` and a non-empty `storeIds` array in the JSON body; include `isAdmin` and `roles[]` such as `staff`, `schedule`, or `chores` to grant additional permissions. Omitting `isAdmin` or `roles[]` preserves existing values.

`stores.php` lists, creates, updates, and deletes stores for a company. Super admins may operate on any company; company admins are limited to their own company via the required `company_id` parameter.

`roles.php` allows super admins or company admins to list, create, update, and delete roles via `GET`, `POST`, and `DELETE` requests.

`metrics.php` returns aggregated shift counts and pending chore totals for charts. Provide `company_id` and optional `timeframe=week|month`. Super admins and company admins can view metrics for their companies.

`settings.php` manages company and store settings, including break policies. It accepts `GET`, `POST`, and `DELETE` methods with a required `company_id` and optional `store_id`. Sending break policy fields (`maxConcurrent`, `minSpacing`, `lunchStart`, `lunchEnd`) reads or saves break settings for a store.

`templates.php` stores automation rule templates per company. `GET` returns all templates, seeding a default from the break policy when none exist. `POST` with a `name` and `rules[]` creates or updates a template, and `DELETE` with an `id` removes one.

`audit.php` lists audit log entries. It requires a `company_id` and supports optional `user_id`, `action`, `page` and `per_page` parameters. Super admins or company admins can view logs for their own company. Results are returned in reverse chronological order with `id`, `user_id`, `email`, `action`, `company`, `store` and `created_at` fields.

Common schedule actions include saving, modifying, clearing and printing.

`invitations.php` manages invitation emails and templates. `GET` with `company_id` lists queued invites and available template filenames. Adding a `tpl` parameter returns the content of that template. `POST` queues a new invite when given an `email`, `storeId` and `role`. It also accepts `{ "action": "resend", "id": ID }` to retry a message, `{ "action": "cancel", "id": ID }` to cancel one, and `{ "action": "save_template", "tpl": "invitation.txt", "content": "..." }` to update template text. Templates live in `public/assets/templates` and are plain text files; placeholders wrapped in `{{ }}` such as `{{role}}` are substituted when the email is sent.

The `invitations.php` endpoint remains for compatibility but is not used by the current Company Admin Portal.
