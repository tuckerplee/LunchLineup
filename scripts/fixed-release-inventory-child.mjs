// Private fixed child executable; not the installed/public release entry.
// Only an admitted supervisor may invoke it with the unchanged held FD roster,
// immutable executable/import/native-loader exposure and a sanitized environment.
import { writeSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { stableJson } from './internal-ci-evidence.mjs';
import { consumeHeldReleaseInventoryRequest } from './fixed-release-inventory-worker.mjs';

const need = (ok, message) => { if (!ok) throw new Error(message); };
const natural = text => {
 need(typeof text === 'string' && /^(0|[1-9][0-9]*)$/.test(text), 'Canonical scalar required.');
 const value = Number(text);
 need(Number.isSafeInteger(value), 'Safe scalar required.');
 return value;
};

export async function runFixedReleaseInventoryChild(args) {
 need(Array.isArray(args) && args.length === 11 && args.every(value => typeof value === 'string'), 'Exact fixed child arguments required.');
 const [fdText, sizeText, sha256, deviceText, inodeText, readText, issuedText, expiresText, resultText, uidText, gidText] = args;
 const requestFd = natural(fdText), bytes = natural(sizeText), device = natural(deviceText), inode = natural(inodeText);
 const maxRequestBytes = natural(readText), issuedEpoch = natural(issuedText), expiresEpoch = natural(expiresText), maxResultBytes = natural(resultText);
 const uid = natural(uidText), gid = natural(gidText);
 need(requestFd > 2 && uid > 0 && gid > 0 && process.getuid() === uid && process.geteuid() === uid && process.getgid() === gid && process.getegid() === gid && process.getgroups().every(group => group === gid), 'Nonroot fixed child credentials differ.');
 need(/^[a-f0-9]{64}$/.test(sha256) && bytes > 0 && maxRequestBytes > 0 && maxRequestBytes <= 64 * 1024 * 1024 && bytes <= maxRequestBytes && maxResultBytes > 0 && maxResultBytes <= 64 * 1024 * 1024 && issuedEpoch > 0 && expiresEpoch > issuedEpoch, 'Finite independent child bounds required.');
 const entered = Date.now() / 1000;
 need(entered >= issuedEpoch && entered < expiresEpoch, 'Original child window unavailable.');
 const end = process.hrtime.bigint() + BigInt(Math.floor((expiresEpoch - entered) * 1e9));
 const check = () => { const now = Date.now() / 1000; need(now >= issuedEpoch && now < expiresEpoch && process.hrtime.bigint() < end, 'Original child deadline elapsed.'); };
 const result = await consumeHeldReleaseInventoryRequest({ requestFd, expectedRequest: { bytes, sha256, device, inode }, maxRequestBytes, issuedEpoch, expiresEpoch });
 check();
 need(result?.summary?.acceptance === false && result.summary.admission === false && result.summary.kind === 'disposable-release-inventory-validation', 'Child result authority differs.');
 const output = Buffer.from(stableJson(result), 'utf8');
 need(output.length > 0 && output.length <= maxResultBytes, 'Exact encoded result byte bound.');
 let offset = 0;
 while (offset < output.length) {
  check();
  const count = writeSync(1, output, offset, Math.min(65536, output.length - offset));
  need(count > 0, 'Short child result write.');
  offset += count;
 }
 check();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
 try {
  await runFixedReleaseInventoryChild(process.argv.slice(2));
 } catch {
  // Fixed bounded diagnostic; no candidate stack/path/secret serialization.
  try { writeSync(2, 'Fixed release inventory child failed.\n'); } catch {}
  process.exitCode = 1;
 }
}
