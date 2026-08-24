export const REQUIRED_INTERNAL_BETA_GATES = Object.freeze([
  'source-identity', 'dependency-audit', 'license-policy', 'lint', 'typecheck',
  'migration-hygiene', 'observability-validation', 'terraform-validation',
  'semgrep-full', 'semgrep-delta', 'codeql-javascript-typescript', 'codeql-python',
  'javascript-unit', 'engine-unit', 'worker-unit', 'source-build', 'mock-playwright',
  'database-integration', 'public-build-contract', 'release-image-build',
  'production-image-inventory', 'release-stack-health', 'fullstack-playwright',
  'interaction-proof', 'dast', 'load', 'sbom', 'trivy', 'artifact-integrity',
]);
