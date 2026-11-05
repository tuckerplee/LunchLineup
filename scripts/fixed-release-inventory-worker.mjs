// Private child bridge only: no CLI, spawn, installed role or public dispatch.
// The authenticated owner must pass its same sealed, read-only request OFD and
// exact inherited input FD numbers. Node does not measure seals, O_RDONLY or
// fs-verity. Those kernel checks and lifetime/closure admission belong to owner.
import { fstatSync, readSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { validateSelectedDisposableReleaseInventoryFromFds } from './fixed-release-inventory-selection.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const positive = value => Number.isSafeInteger(value) && value > 0;
const exact = (value, keys) => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));

// Arguments come from future admitted owner transport, never from parsed request.
// All descriptors are borrowed: positional reads only, no close or path fallback.
export async function consumeHeldReleaseInventoryRequest({ requestFd, expectedRequest, maxRequestBytes, issuedEpoch, expiresEpoch }) {
 need(Number.isSafeInteger(requestFd) && requestFd >= 0, 'Exact borrowed request FD required.');
 need(exact(expectedRequest, ['bytes', 'sha256', 'device', 'inode']) && positive(expectedRequest.bytes) && typeof expectedRequest.sha256 === 'string' && /^[a-f0-9]{64}$/.test(expectedRequest.sha256) && ['device', 'inode'].every(key => Number.isSafeInteger(expectedRequest[key]) && expectedRequest[key] >= 0), 'Independent request pin required.');
 // Copy scalar expectations before any await; subsequent caller mutation cannot
 // change the admitted identity or original window.
 const pin = { ...expectedRequest };
 need(positive(maxRequestBytes) && maxRequestBytes <= 64 * 1024 * 1024 && pin.bytes <= maxRequestBytes && positive(issuedEpoch) && positive(expiresEpoch) && issuedEpoch < expiresEpoch, 'Explicit request/window bounds required.');
 const entered = Date.now() / 1000;
 need(entered >= issuedEpoch && entered < expiresEpoch, 'Original request window unavailable.');
 const end = process.hrtime.bigint() + BigInt(Math.floor((expiresEpoch - entered) * 1e9));
 const check = () => { const now = Date.now() / 1000; need(now >= issuedEpoch && now < expiresEpoch && process.hrtime.bigint() < end, 'Original request deadline elapsed.'); };
 const fields = ['dev', 'ino', 'mode', 'uid', 'gid', 'nlink', 'size', 'mtimeNs', 'ctimeNs'];
 const before = fstatSync(requestFd, { bigint: true });
 need(before.isFile() && before.uid === 0n && before.gid === 0n && (before.mode & 0o7777n) === 0o400n && before.size === BigInt(pin.bytes) && before.dev === BigInt(pin.device) && before.ino === BigInt(pin.inode), 'Held request identity differs.');
 const observe = () => { check(); const after = fstatSync(requestFd, { bigint: true }); need(fields.every(key => before[key] === after[key]), 'Held request changed.'); };
 check();
 const bytes = Buffer.alloc(pin.bytes);
 let offset = 0;
 while (offset < bytes.length) {
  check();
  const count = readSync(requestFd, bytes, offset, Math.min(1024 * 1024, bytes.length - offset), offset);
  need(count > 0, 'Truncated held request.');
  offset += count;
 }
 need(readSync(requestFd, Buffer.alloc(1), 0, 1, offset) === 0, 'Trailing held request bytes.');
 observe();
 need(createHash('sha256').update(bytes).digest('hex') === pin.sha256, 'Independent request digest differs.');
 const request = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
 observe();
 need(exact(request, ['authority', 'selection', 'borrowedFds', 'expectedInputPins', 'limits']) && request.limits?.issuedEpoch === issuedEpoch && request.limits?.expiresEpoch === expiresEpoch, 'Request shape/original window differs.');
 need(request.borrowedFds !== null && typeof request.borrowedFds === 'object' && !Array.isArray(request.borrowedFds), 'Explicit inherited descriptor table required.');
 const descriptors = Object.values(request.borrowedFds);
 need(descriptors.every(fd => Number.isSafeInteger(fd) && fd >= 0 && fd !== requestFd) && new Set(descriptors).size === descriptors.length, 'Request/input descriptor collision.');
 // Existing consumer validates complete artifact/bootstrap union and all original
 // source/schema/image/service constraints; no parser or authority duplication.
 const result = await validateSelectedDisposableReleaseInventoryFromFds(request);
 observe();
 return result;
}
