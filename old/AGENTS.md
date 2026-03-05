# AGENTS.md

## General
- PHP should follow PSR-12 style conventions.
- Format JavaScript with Prettier defaults and include semicolons.
- Avoid introducing external frameworks or build steps; keep the project dependency-free.

## Naming
- Use `snake_case` for file and directory names.
- Name PHP classes in `PascalCase` to match their file names.
- Use `camelCase` for function and variable names.
- Use `UPPER_SNAKE_CASE` for constants.

## Pre-commit Checks
- Run `php -l $(git ls-files '*.php')` to verify PHP syntax.
- Run `node --check $(git ls-files '*.js')` to check JavaScript syntax.
- If new scripts or directories are added, document them in the corresponding README.
- Review `to-do.txt` when preparing to push changes. If your work corresponds to an existing entry, update that item with the latest status and notes. If your changes are unrelated to any listed to-do, leave the backlog untouched.

## Commit Guidelines
- Keep commit messages short and in the imperative mood, e.g. "Add schedule parser."
- Reference issue numbers where applicable: "Fix PDF import (#42)."

## Documentation
- Update the main `README.md` and any folder-specific README when API behavior or usage changes.

## Testing
- Manual testing can be done via `php -S localhost:8000` and visiting the site in a browser.
- If automated tests are added, run them before committing.

### UI Test Routine
1. Start a local MySQL/MariaDB server.
2. Remove any existing `config.php` and launch the app with `php -S localhost:8000 -t public`.
3. Visit `http://localhost:8000/index.php` and follow the setup wizard to enter database credentials and create the Super Admin account.
4. After setup, log in as the Super Admin and open the **Companies** card.
5. Create a new company, then click **manage** beside it and add a store. Confirm you return to the Manage Company page.
6. From the same page, add a user for that company and ensure you return to the Manage Company page.
7. Log out, sign in with the new user, navigate to **Staff**, add a staff member, and save.
