# Account Deletion Confirmation

Public, no-index confirmation page shown after a tenant deletion request revokes the active browser session.

## Files

- `AccountDeletionConfirmation.tsx`: client receipt view that distinguishes pending billing reconciliation from finalized deletion while reading only the tab-scoped receipt.
- `account-deletion-receipt.ts`: strict response-to-receipt state/date normalization and tab-scoped storage helpers that exclude tenant identifiers, provider errors, and tokens.
- `page.tsx`: public confirmation route with retention dates, monitored support routing, and no URL-carried receipt data.
- `README.md`: this account-deletion confirmation folder guide.
