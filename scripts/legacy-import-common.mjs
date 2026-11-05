import crypto from 'node:crypto';

// Small validation helpers shared by the legacy import planners. Error texts keep
// the "Legacy import plan refused:" prefix the CLI recognises as safe to print.
export const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
export const stable = (value) => JSON.stringify(value);
export function fail(message) { throw new Error(`Legacy import plan refused: ${message}`); }
export function record(value, label) { if (!value || typeof value !== 'object' || Array.isArray(value)) fail(`${label} must be an object`); return value; }
export function exactKeys(value, keys, label) { record(value, label); if (Object.keys(value).sort().join('|') !== [...keys].sort().join('|')) fail(`${label} has unsupported or missing fields`); }
export function id(value, label) {
  const raw = typeof value === 'number' && Number.isInteger(value) ? String(value) : value;
  if (typeof raw !== 'string' || !/^[1-9][0-9]{0,9}(?![\s\S])/.test(raw) || BigInt(raw) > 4294967295n) fail(`${label} must be a canonical positive UINT32`);
  return raw;
}
export function text(value, label, max, { nullable = false } = {}) {
  if (nullable && (value === null || value === undefined || value === '')) return null;
  if (typeof value !== 'string' || !value.trim() || value.length > max || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) fail(`${label} is invalid or exceeds its bound`);
  return value;
}
export function alias(row, first, second, fallback) {
  if (row[first] !== undefined && row[second] !== undefined && row[first] !== row[second]) fail(`conflicting ${first}/${second} aliases`);
  return row[first] ?? row[second] ?? fallback;
}
