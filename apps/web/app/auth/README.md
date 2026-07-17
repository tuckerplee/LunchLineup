# Web Auth Routes

## Folders

- `account-deleted/`: public, no-index deletion receipt page with date-only tab storage and monitored support routing.
- `login/`: browser login page with retryable JSON verification for email OTP, migrated username/password, and PIN flows.
- `logout/`: browser logout route; see `logout/README.md`.
- `reset-pin/`: forced temporary-PIN rotation page that clears the revoked session through logout before a fresh sign-in.
- `reset-password/`: no-referrer password reset request and confirmation page with pre-render URL token scrubbing and retry-safe confirmation.

## Files

- `README.md`: this auth route folder guide.
