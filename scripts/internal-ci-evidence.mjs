import { createHash } from 'node:crypto';
import { closeSync, constants, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

const normalize = (value) => Array.isArray(value) ? value.map(normalize) : value && typeof value === 'object' ? Object.fromEntries(Object.keys(value).sort().map((key) => [key, normalize(value[key])])) : value;
export const stableJson = (value) => `${JSON.stringify(normalize(value), null, 2)}\n`;
const inside = (root, candidate, allowEqual = false) => { const rel = relative(root, candidate); return (allowEqual && rel === '') || (rel !== '' && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)); };

export function assertNoAbsoluteHostPaths(value, label = 'persistent evidence') {
  const inspect = (item) => {
    if (Array.isArray(item)) return item.forEach(inspect);
    if (item && typeof item === 'object') return Object.values(item).forEach(inspect);
    if (typeof item === 'string' && (/^[A-Za-z]:[\\/]/.test(item) || /^\\\\[^\\]+\\[^\\]+/.test(item) || /^\/(?:home|root|var|tmp|run|srv)\//.test(item))) throw new Error(`${label} must not contain absolute host paths.`);
  };
  inspect(value);
}

export function assertNoSymlinkComponents(path, root) {
  if (!root) throw new Error('Evidence root is required.');
  const base = resolve(root);
  if (!existsSync(base) || lstatSync(base).isSymbolicLink() || !statSync(base).isDirectory()) throw new Error('Evidence root must be a real directory.');
  const realBase = realpathSync(base), absolute = resolve(path);
  if (!inside(realBase, absolute, true)) throw new Error('Evidence path escapes root.');
  let current = realBase;
  for (const part of relative(realBase, absolute).split(/[\\/]/).filter(Boolean)) { current = resolve(current, part); if (existsSync(current) && lstatSync(current).isSymbolicLink()) throw new Error('Evidence symlink rejected.'); }
  if (existsSync(absolute) && !inside(realBase, realpathSync(absolute), true)) throw new Error('Evidence path escapes root.');
}

export function relativeEvidencePath(path, root) {
  assertNoSymlinkComponents(path, root);
  const rel = relative(realpathSync(root), resolve(path));
  if (!rel || isAbsolute(rel) || rel === '..' || rel.startsWith(`..${sep}`)) throw new Error('Evidence path must be beneath root.');
  return rel.replaceAll('\\', '/');
}

export function statRegularEvidenceFile(path, root) { const itemPath = relativeEvidencePath(path, root), stat = lstatSync(path); if (stat.isSymbolicLink() || !stat.isFile()) throw new Error('Evidence must be a regular file.'); return { path: itemPath, bytes: stat.size }; }

export function readRegularEvidenceSnapshot(path, root, { maxBytes = 64 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 64 * 1024 * 1024) throw new Error('Invalid evidence snapshot limit.');
  const item = statRegularEvidenceFile(path, root);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd);
    if (!before.isFile() || before.size > maxBytes) throw new Error('Evidence snapshot is not a bounded regular file.');
    const bytes = Buffer.allocUnsafe(before.size);
    let position = 0;
    while (position < before.size) {
      const count = readSync(fd, bytes, position, before.size - position, position);
      if (!count) break;
      position += count;
    }
    const after = fstatSync(fd);
    if (position !== before.size || before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs) throw new Error('Evidence changed while reading.');
    const finalPath = lstatSync(path);
    if (finalPath.isSymbolicLink() || finalPath.dev !== before.dev || finalPath.ino !== before.ino || finalPath.size !== before.size || finalPath.mtimeMs !== before.mtimeMs) throw new Error('Evidence path changed while reading.');
    return { ...item, bytes };
  } finally { closeSync(fd); }
}

export async function sha256File(path, root) {
  if (root) statRegularEvidenceFile(path, root);
  const fd = openSync(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = fstatSync(fd); if (!before.isFile()) throw new Error('Evidence must be a regular file.');
    const hash = createHash('sha256'), buffer = Buffer.allocUnsafe(1024 * 1024); let position = 0;
    while (position < before.size) { const bytesRead = readSync(fd, buffer, 0, Math.min(buffer.length, before.size - position), position); if (!bytesRead) break; hash.update(buffer.subarray(0, bytesRead)); position += bytesRead; }
    const after = fstatSync(fd);
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.mtimeMs !== after.mtimeMs || position !== before.size) throw new Error('Evidence changed while hashing.');
    if (root) {
      statRegularEvidenceFile(path, root);
      const finalPath = lstatSync(path);
      if (finalPath.dev !== before.dev || finalPath.ino !== before.ino || finalPath.size !== before.size || finalPath.mtimeMs !== before.mtimeMs) throw new Error('Evidence path changed while hashing.');
    }
    return hash.digest('hex');
  } finally { closeSync(fd); }
}

export function readJsonEvidence(path, root, label = 'JSON evidence') { const snapshot = readRegularEvidenceSnapshot(path, root); const value = JSON.parse(snapshot.bytes.toString('utf8')); assertNoAbsoluteHostPaths(value, label); return value; }

export function writeExclusiveJson(path, value, { root } = {}) {
  if (!root) throw new Error('Evidence root is required.');
  assertNoAbsoluteHostPaths(value);
  const output = resolve(path), base = realpathSync(root);
  if (!inside(base, output)) throw new Error('Evidence output must be beneath root.');
  mkdirSync(dirname(output), { recursive: true, mode: 0o700 }); assertNoSymlinkComponents(dirname(output), base);
  writeFileSync(output, stableJson(value), { flag: 'wx', mode: 0o600 });
}

export function sortedDirectoryInventory(root, { maxFiles = 25000, maxBytes = 50 * 1024 * 1024 * 1024 } = {}) {
  if (!Number.isSafeInteger(maxFiles) || maxFiles < 1 || maxFiles > 25000 || !Number.isSafeInteger(maxBytes) || maxBytes < 1 || maxBytes > 50 * 1024 * 1024 * 1024) throw new Error('Invalid evidence inventory limits.');
  assertNoSymlinkComponents(root, root); const files = []; let bytes = 0;
  const walk = (dir) => { for (const name of readdirSync(dir).sort()) { const path = resolve(dir, name), stat = lstatSync(path); if (stat.isSymbolicLink()) throw new Error('Evidence symlink rejected.'); if (stat.isDirectory()) walk(path); else { if (!stat.isFile()) throw new Error('Evidence must be regular.'); const item = statRegularEvidenceFile(path, root); files.push(item); bytes += item.bytes; if (files.length > maxFiles) throw new Error('Evidence file limit exceeded.'); if (bytes > maxBytes) throw new Error('Evidence byte limit exceeded.'); } } };
  walk(realpathSync(root)); return files;
}
