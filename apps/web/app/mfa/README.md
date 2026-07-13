# MFA Route

## Files

- `README.md`: this MFA route folder guide.
- `page.tsx`: client-side MFA verification and mandatory-enrollment page with assistive-technology error announcements and a support-config-backed recovery action for privileged users who lose every factor; one-time recovery codes require explicit save acknowledgment before redirect and support accessible copy/print actions without browser persistence.
- `recovery-codes.ts`: pure response normalization and clipboard-text formatting for one-time MFA recovery codes.
