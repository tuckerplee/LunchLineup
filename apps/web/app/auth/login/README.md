# Login Page

## Files

- `README.md`: this login folder guide.
- `page.tsx`: client login UI that resolves identifiers into email OTP, migrated username/password, or username/PIN flows, announces dynamic errors to assistive technology, prefills the most recently remembered workspace slug, and hides self-service onboarding while production is closed beta.

## Notes

Legacy LunchLineup users should use their migrated username and original password. The password step links to `/auth/reset-password` for emailed reset links. PIN login remains available for accounts that do not have a migrated password hash. A temporary PIN login is redirected to `/auth/reset-pin` and cannot reach the application or MFA enrollment until the PIN is replaced.

An explicit workspace query parameter wins over the locally remembered slug. Successful workspace entry refreshes the remembered value; login OTP values are never written to browser storage.
