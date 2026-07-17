# Logout Route

## Files

- `README.md`: this logout folder guide.
- `route.ts`: same-origin logout handler that preserves browser credentials on ambiguous API revocation failures, clears them after authoritative revocation, and supports API-free local cookie clearing after tenant deletion has already revoked every session.
