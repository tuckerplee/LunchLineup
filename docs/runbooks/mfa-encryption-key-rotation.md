# MFA Encryption Key Rotation

## Scope

Use this procedure to move every enrolled `User.mfaSecret` to a new managed AES-256-GCM key without locking users out. The script emits counts and key references only. Never log key values, plaintext TOTP secrets, or database rows.

## Preconditions

- Push the committed release to GitHub before server deployment.
- Back up the database and confirm restore readiness.
- Set `MIGRATION_DATABASE_URL` to the owner/admin connection and `PLATFORM_ADMIN_DB_CONTEXT_SECRET` to the platform-admin database capability.
- Generate a new random 32-byte key encoded as 64 hex characters or base64.
- Keep the old key available until current-only verification succeeds.

## Establish Overlap

For a managed-key rotation, deploy with the new key as `MFA_SECRET_ENCRYPTION_KEY_CURRENT` and the former managed key as `MFA_SECRET_ENCRYPTION_KEY_PREVIOUS`.

For the first migration from legacy `enc:v1` rows, set the new managed key as `MFA_SECRET_ENCRYPTION_KEY_CURRENT` and retain the exact former value as deprecated `MFA_SECRET_ENCRYPTION_KEY`. Do not reinterpret or re-encode the legacy value because v1 derived its AES key by hashing that string.

Production bootstrap requires the current managed key to decode from strict hex or base64 to exactly 32 bytes. Previous managed keys must meet the same rule when present. The deprecated legacy overlap value must remain a non-placeholder secret of at least 32 characters. Bootstrap rejects duplicate configured values and keys that resolve to the same encryption bytes.

Run the read-only validation first:

```bash
node scripts/rotate-auth-secrets.mjs
```

The dry run must complete without an undecryptable row. `overlapRows` is the number of plaintext, previous-key, or legacy-key rows that still need migration.

## Re-encrypt Transactionally

```bash
AUTH_SECRET_ROTATION_EXECUTE_CONFIRM=rotate-auth-secrets \
  node scripts/rotate-auth-secrets.mjs --execute
```

The command locks the auth tables, decrypts every non-null MFA secret before writing, re-encrypts all enrolled secrets under the current key, and verifies every resulting envelope with the current key alone in one serializable transaction. Any unsupported or undecryptable row rolls back all refresh-token and MFA changes. Success requires `previousDependencyRows` to equal `0`.

Add `--revoke-sessions` only when the approved change also revokes sessions whose legacy plaintext refresh tokens are hashed by this command.

## Verify Removal

Remove `MFA_SECRET_ENCRYPTION_KEY_PREVIOUS` and deprecated `MFA_SECRET_ENCRYPTION_KEY` from a local copy of the runtime environment, leaving only `MFA_SECRET_ENCRYPTION_KEY_CURRENT`, then run:

```bash
node scripts/rotate-auth-secrets.mjs
node scripts/validate-production-launch.mjs /path/to/current-only-runtime.env
```

Both commands must succeed, and the rotation dry run must report `overlapRows: 0`. This is the fail-closed proof that the old key can be removed. Deploy the current-only environment only after that proof. Keep the retired key in the managed secret archive according to incident-recovery policy; do not leave it in Compose or application runtime configuration.

## Failure

Do not remove either overlap key when the script fails or reports dependencies. Preserve the database and runtime key set, investigate the count-only failure without printing secret material, and rerun the dry run after remediation.
