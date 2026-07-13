# Reset PIN Page

## Files

- `README.md`: this reset-pin folder guide.
- `page.tsx`: reset-only session UI that rotates a temporary PIN before handing off to logout so revoked session cookies are cleared and the user signs in again.

## Security Notes

The page never stores either PIN. The API limits temporary-PIN sessions to self rotation, logout, and identity display; MFA enrollment and application routes remain unavailable until rotation succeeds.
