# Production infrastructure inputs

## Files

- `README.md`: this folder guide.
- `runtime.env.example`: production runtime env template with no secrets; `OWNER:` and `GENERATE_ME` markers must be replaced and the result validated with `node scripts/check-production-env.mjs`.
