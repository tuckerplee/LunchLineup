# Super Admin

Global dashboard for system-wide tasks. The portal presents cards for:

- **Companies** – create, edit, or fully manage a company (stores and users)
- **Users** – view existing company users, edit profiles, reset passwords,
  change roles, and review logs
- **Staff** – manage non-login staff by selecting a company and creating or editing entries
- **Logs** – review access logs
- **Back End** – link to the upgrade coordinator for applying database scripts
- **Backup/Restore** – select a company, view recent backups, and create, restore, or delete password-protected database backups. Files are stored in `public/backups/{company}/{date}/`.
- **Tests** – run backend test scripts

A summary row above the cards displays total counts for companies, users and audit logs.

Refer to [docs/user_staff_architecture.md](../../docs/user_staff_architecture.md) for how user and staff data flows through the system.

Selecting a card loads a dedicated super-admin page in a modal. Most pages call the modular `../api/` endpoints; only maintenance tasks such as logs or schema rebuilds use `../superadmin-api/`. Modal pages can still navigate to other super-admin pages by calling `openAdminModal(url, title)`.

The Staff card first shows a company selector. Each **Manage Staff** button uses `openAdminModal` to keep navigation in the modal, and staff forms set `window.COMPANY_ID` so cancel actions return to the correct list.

Pages that operate on a specific company should set a global `COMPANY_ID` variable (for example, `window.COMPANY_ID = 123`) so navigation helpers can return to the correct company context.
