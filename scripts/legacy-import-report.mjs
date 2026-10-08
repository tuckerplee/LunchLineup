import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
export { readLegacyImportReport } from './legacy-import-executor.mjs';
export const REPORT_MAX_BYTES = 16777216;
export const REPORT_MAX_ROWS = 20000;
export const REPORT_MAX_CELL_BYTES = 8192;
const FIELDS = ['sourceType','legacyId','companyId','tenantId','targetId','currentUsername','currentName','initialRole','currentPasswordCredentialPresent','importNote','deleted'];
const canonicalId = (value) => typeof value === 'string' && /^[1-9][0-9]{0,9}(?![\s\S])/.test(value) && BigInt(value) <= 4294967295n;
function exactObject(value, keys) { return value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).sort().join('|') === [...keys].sort().join('|'); }
function validateReport(report) {
  if (!exactObject(report, ['namespace','targetGenerationId','sourceSha256','counts','companies','rows']) || typeof report.namespace !== 'string' || !/^[a-z][a-z0-9._:-]{2,127}(?![\s\S])/.test(report.namespace) || typeof report.targetGenerationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}(?![\s\S])/.test(report.targetGenerationId) || typeof report.sourceSha256 !== 'string' || !/^[0-9a-f]{64}(?![\s\S])/.test(report.sourceSha256)) throw new Error('Invalid legacy import report envelope');
  if (!exactObject(report.counts, ['company','location','user','staff']) || Object.values(report.counts).some((count) => !Number.isSafeInteger(count) || count < 0 || count > REPORT_MAX_ROWS) || report.counts.company < 1 || !Array.isArray(report.rows) || report.rows.length > REPORT_MAX_ROWS || !Array.isArray(report.companies) || report.companies.length !== report.counts.company) throw new Error('Legacy import report exceeds row bound or has malformed counts');
  const companies = new Map(); const tenants = new Set();
  for (const row of report.companies) {
    if (!exactObject(row, ['companyId','tenantId']) || !canonicalId(row.companyId) || typeof row.tenantId !== 'string' || !row.tenantId || row.tenantId.length > 128 || companies.has(row.companyId) || tenants.has(row.tenantId)) throw new Error('Invalid report company ownership');
    companies.set(row.companyId, row.tenantId); tenants.add(row.tenantId);
  }
  const counts = { location: 0, user: 0, staff: 0 }; const sourceKeys = new Set(); const targetKeys = new Set();
  for (const row of report.rows) {
    if (!exactObject(row, FIELDS) || !Object.hasOwn(counts, row.sourceType) || !canonicalId(row.legacyId) || !canonicalId(row.companyId) || companies.get(row.companyId) !== row.tenantId || typeof row.targetId !== 'string' || !row.targetId || row.targetId.length > 128 || typeof row.currentPasswordCredentialPresent !== 'boolean' || typeof row.deleted !== 'boolean' || FIELDS.some((key) => !['currentPasswordCredentialPresent','deleted'].includes(key) && typeof row[key] !== 'string') || (row.sourceType === 'location' ? row.initialRole !== '' || row.currentUsername !== '' || row.currentPasswordCredentialPresent : !['ADMIN','MANAGER','STAFF'].includes(row.initialRole))) throw new Error('Invalid report row binding');
    const source = JSON.stringify([row.companyId,row.sourceType,row.legacyId]); const target = JSON.stringify([row.sourceType === 'location' ? 'location' : 'account',row.targetId]);
    if (sourceKeys.has(source) || targetKeys.has(target)) throw new Error('Ambiguous report identities');
    sourceKeys.add(source); targetKeys.add(target); counts[row.sourceType] += 1;
  }
  if (Object.keys(counts).some((key) => counts[key] !== report.counts[key])) throw new Error('Report count does not match scoped rows');
}

function safeCell(value) {
  let result = String(value ?? '');
  // A leading spreadsheet formula may follow whitespace or a control byte.
  if (/^[\s\u0000-\u001f]*[=+@-]/.test(result) || /^[\t\r\n]/.test(result)) result = `'${result}`;
  return /[",\r\n]/.test(result) ? `"${result.replaceAll('"', '""')}"` : result;
}
export function legacyImportReportCsv(report) {
  validateReport(report);
  const fields = FIELDS;
  const lines = [`${fields.join(',')}\n`];
  let bytes = Buffer.byteLength(lines[0]);
  for (const row of report.rows) {
    if (!row || typeof row !== 'object' || Array.isArray(row)) throw new Error('Invalid legacy import report row');
    const cells = fields.map((key) => {
      const value = row[key];
      if (!['string','boolean'].includes(typeof value) || Buffer.byteLength(String(value)) > REPORT_MAX_CELL_BYTES) throw new Error('Legacy import report cell exceeds finite bound or has invalid type');
      return safeCell(value);
    });
    const line = `${cells.join(',')}\n`;
    bytes += Buffer.byteLength(line);
    if (bytes > REPORT_MAX_BYTES) throw new Error('Legacy import report exceeds byte bound');
    lines.push(line);
  }
  return lines.join('');
}
function checkedDirectory(directory) {
  const resolved = path.resolve(directory);
  // Refuse symlinked ancestors, including a substituted final task directory.
  let cursor = path.parse(resolved).root;
  let leafStat = fs.lstatSync(cursor);
  for (const part of resolved.slice(cursor.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    const stat = fs.lstatSync(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Legacy import report directory must not traverse symlinks');
    leafStat = stat;
  }
  const stat = leafStat;
  if ((stat.mode & 0o777) !== 0o700 || (process.getuid && stat.uid !== process.getuid())) throw new Error('Legacy import report requires an existing owned0700 directory');
  return { directory: resolved, dev: stat.dev, ino: stat.ino };
}
function checkedReportPath(requestedPath) {
  if (typeof requestedPath !== 'string' || !requestedPath) throw new Error('Legacy import report requires an explicit path');
  const target = path.resolve(requestedPath);
  const checked = checkedDirectory(path.dirname(target));
  try { fs.lstatSync(target); } catch (error) { if (error.code === 'ENOENT') return { target, checked }; throw error; }
  throw new Error('Legacy import report target already exists; evidence cannot be overwritten');
}
export function validateLegacyImportReportPath(requestedPath) {
  return checkedReportPath(requestedPath).target;
}
export function publishLegacyImportReport(report, { path: requestedPath }) {
  const { target, checked } = checkedReportPath(requestedPath);
  const directory = checked.directory;
  const name = path.basename(target);
  if (!name || name === '.' || name === '..') throw new Error('Invalid report filename');
  const directoryFd = fs.openSync(directory, fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW);
  let tempPath;
  let fd;
  let primary;
  try {
    const boundStat = fs.fstatSync(directoryFd);
    if (boundStat.dev !== checked.dev || boundStat.ino !== checked.ino || !boundStat.isDirectory() || (boundStat.mode & 0o777) !== 0o700 || (process.getuid && boundStat.uid !== process.getuid())) throw new Error('Opened report directory is outside checked private custody');
    // Bind publication to the opened directory, even if an ancestor is renamed.
    const boundDirectory = `/proc/self/fd/${directoryFd}`;
    const boundTarget = path.join(boundDirectory, name);
    tempPath = path.join(boundDirectory, `.legacy-import-${crypto.randomUUID()}.tmp`);
    fd = fs.openSync(tempPath, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, 0o600);
    fs.writeFileSync(fd, legacyImportReportCsv(report), 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd); fd = undefined;
    // link fails if any target already exists; rename would overwrite evidence.
    fs.linkSync(tempPath, boundTarget);
    fs.unlinkSync(tempPath); tempPath = undefined;
    fs.fsyncSync(directoryFd);
    return target;
  } catch (error) {
    primary = error;
    throw error;
  } finally {
    let cleanup;
    try { if (fd !== undefined) fs.closeSync(fd); } catch (error) { cleanup = error; }
    try { if (tempPath) fs.unlinkSync(tempPath); } catch (error) { cleanup ??= error; }
    try { fs.closeSync(directoryFd); } catch (error) { cleanup ??= error; }
    if (cleanup) {
      if (primary) throw new AggregateError([primary, cleanup], 'Legacy import report publication and cleanup failed');
      throw cleanup;
    }
  }
}
