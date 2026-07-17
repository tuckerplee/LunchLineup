# Reset Password Page

## Files

- `README.md`: this reset-password folder guide.
- `page.tsx`: client reset UI that consumes the proxy's short-lived path cookie, removes any fallback token query with `history.replaceState`, sends the token only in the confirmation JSON body, distinguishes invalid links from throttling/service failures, and preserves retryable password input with branded loading and focused live feedback.

## Notes

The request form intentionally shows the same success response whether or not an eligible migrated username/password account exists.
The web proxy exchanges `?token=` for a 15-minute cookie scoped to this route before rendering, and the route response enforces `Referrer-Policy: no-referrer` plus `Cache-Control: no-store`.
