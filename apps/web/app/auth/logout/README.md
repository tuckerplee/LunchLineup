# Logout Route

## Files

- `README.md`: this logout folder guide.
- `route.ts`: same-origin API logout proxy that forwards refresh and CSRF cookies, preserves browser credentials on ambiguous failures, and clears them only after authoritative revocation or already-invalid confirmation.
