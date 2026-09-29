import { parseApprovedAppOrigin } from './safe-navigation';

// This policy is used only by server authentication boundaries. Public build
// flags never authorize an HTTP application origin in a production Next build.
export function approvedServerAppOrigin(configured: string | undefined, fallback: string): string | null {
  const qaFlag = process.env.LUNCHLINEUP_DEVELOPMENT_QA;
  if (qaFlag !== undefined && qaFlag !== '0') {
    if (qaFlag !== '1'
      || process.env.DATA_TARGET_ENV !== 'disposable'
      || process.env.APP_ENV !== 'test'
      || process.env.DEPLOY_ENV !== 'test'
      || configured !== 'http://127.0.0.1:8080') return null;
    // Compare the raw value: URL normalization must not admit IP aliases,
    // credentials, alternate ports, paths, or a request-header fallback.
    return configured;
  }
  if (configured?.trim()) {
    return parseApprovedAppOrigin(configured.trim(), process.env.NODE_ENV === 'production');
  }
  if (process.env.NODE_ENV === 'production') return null;
  return parseApprovedAppOrigin(fallback, false);
}
