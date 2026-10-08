# Shared RBAC Policy

## Files

- `README.md`: this package guide.
- `mfa-session.ts`: bounded exact-session MFA marker/TTL observation and wall/monotonic lifetime verification shared by API generations.
- `index.ts`: Casbin and shared-policy exports.
- `model.conf`: Casbin authorization model.
- `package.json`: package metadata and scripts.
- `permissions.ts`: MFA-required permission policy shared by API generations.
- `policy.csv`: Casbin authorization policy.
- `tsconfig.json`: strict TypeScript build configuration.
