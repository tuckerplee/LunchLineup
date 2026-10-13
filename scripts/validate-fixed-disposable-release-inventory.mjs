// Intentionally unavailable until the release owner implements immutable input
// custody, imported executable closure admission and finite dispatch/retention.
// Parsing a protected selection alone must never become permission to execute.
export function validateFixedDisposableReleaseInventory() {
 throw new Error('Release inventory owner admission and immutable input custody are not installed.');
}
