# Scripts

- **migrate.php** – imports CSV and JSON data into the MySQL database, upgrades the chores schema to the template metadata fields, and seeds each company with the default break policy template; pass `stores`, `user_store_roles`, `schedule`, `chores`, or `csv` arguments to limit what is imported.
- **migrate_breaks.php** – adds a `breaks` JSON column to `shifts` and migrates existing break data.
- **migrate_users.php** – create user accounts for each staff member with a default password.
- **migrate_companies.php** – create a default company, populate `company_id` for existing stores and users, and assign an initial `company_admin` (optionally pass a user ID).
- **migrate_staff_company.php** – populate `company_id` for existing staff based on their store's company.
- **migrate_staff_admin.php** – align `staff.is_admin` flags with company admin roles.
- **migrate_templates.php** – insert the default break policy template for each company (run automatically by `migrate.php`).
- **seed_staff.php** – create staff records for users who lack them.
- **backup.php** – dump the database, decrypt application‑level fields, re‑encrypt them with the provided password and encrypt the resulting SQL with AES‑256‑CBC.
- **restore.php** – decrypt the dump, re‑encrypt decrypted fields using the current `APP_KEY` and load the data into MySQL.
- **password_crypto.php** – helper functions for password‑based field encryption used by the backup and restore scripts.
  These functions are also available through the Super Admin interface at `superadmin/backup.php`.
- **schema.sql** – table definitions executed by the installer.
- **upgrade.php** – runs schema and data upgrades. Execute `php scripts/upgrade.php` to apply pending migrations,
  including the username login conversion.
- **upgrades/upgrade_20250214_username_login.php** – renames legacy email-based login columns to their username
  counterparts and updates related indexes.
- **upgrades/email_hash_upgrade.php** – legacy helper retained for older deployments that still require the hashed
  login column backfill.

All scripts read configuration from the `.env`/`config.php` created by `public/setup.php`. Run the setup wizard or provide those files before executing any script.

Encrypted backups are saved under the `public/backups` directory configured by the `BACKUP_DIR` environment variable.

The application will exit if a JWT secret is missing. Visit `/setup.php` or set the `JWT_SECRET` environment variable before using the scripts.

Run the company migration when enabling multi-company support:
```bash
php scripts/migrate_companies.php [userId]
```

Create an encrypted backup and restore it later:

```bash
php scripts/backup.php dump.sql.enc secret
php scripts/restore.php dump.sql.enc secret
```

