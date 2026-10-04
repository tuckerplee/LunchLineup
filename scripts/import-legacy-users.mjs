#!/usr/bin/env node
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { performance } from 'node:perf_hooks';
import { pathToFileURL } from 'node:url';
import { assertLegacyImportTarget } from './data-target-guard.mjs';
import { buildLegacyImportPlan, DEFAULT_LIMITS } from './legacy-import-plan.mjs';
import { executeLegacyImport, readLegacyImportReport } from './legacy-import-executor.mjs';
import { publishLegacyImportReport, validateLegacyImportReportPath } from './legacy-import-report.mjs';

function argsOf(argv) {
  if (!argv.length || argv[0].startsWith('--')) throw new Error('Usage: import-legacy-users.mjs <export.json> --descriptor <reviewed.json> --report <private.csv> [--report-only]');
  const result = { exportPath: argv[0], reportOnly: false };
  for (let index = 1; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === '--report-only' && !result.reportOnly) { result.reportOnly = true; continue; }
    const key = flag === '--descriptor' ? 'descriptorPath' : flag === '--report' ? 'reportPath' : null;
    if (!key || result[key] || !argv[index + 1] || argv[index + 1].startsWith('--')) throw new Error('Unsupported, repeated or incomplete import option');
    result[key] = argv[++index];
  }
  return result;
}
function readBounded(filename, maxBytes) {
  const fd = fs.openSync(filename, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > maxBytes) throw new Error('Import input must be an in-bound regular file');
    const result = Buffer.alloc(maxBytes + 1);
    let used = 0;
    while (used <= maxBytes) {
      const count = fs.readSync(fd, result, used, result.length - used, null);
      if (!count) return result.subarray(0, used);
      used += count;
    }
    throw new Error('Import input exceeded byte bound while reading');
  } finally { fs.closeSync(fd); }
}
export async function main(argv = process.argv.slice(2), env = process.env, { onAdmittedPlan } = {}) {
  const selectedEnv = Object.freeze({ ...env });
  const selected = argsOf(argv);
  const sourceBytes = readBounded(selected.exportPath, DEFAULT_LIMITS.maxBytes);
  const actualSourceSha256 = crypto.createHash('sha256').update(sourceBytes).digest('hex');
  // Preserve target rejection before descriptor/planner validation and Prisma.
  assertLegacyImportTarget({ env: selectedEnv, actualSourceSha256 });
  if (!selected.descriptorPath || !selected.reportPath) throw new Error('A reviewed descriptor and explicit private report path are mandatory');
  const descriptorBytes = readBounded(selected.descriptorPath, 1048576);
  const plan = buildLegacyImportPlan(sourceBytes, descriptorBytes, { expectedDescriptorSha256: selectedEnv.LEGACY_IMPORT_DESCRIPTOR_SHA256, expectedSourceSha256: selectedEnv.LEGACY_SOURCE_EXPORT_SHA256 });
  const validatedDatabaseUrl = selectedEnv.DATABASE_URL;
  onAdmittedPlan?.(plan.limits.maxDurationMs);
  // Validate output custody before committing any domain effects; publication
  // remains exclusive and can still fail after a successful database commit.
  validateLegacyImportReportPath(selected.reportPath);
  let prisma;
  let primary;
  try {
    const { PrismaClient } = await import('@prisma/client');
    prisma = new PrismaClient({ datasources: { db: { url: validatedDatabaseUrl } } });
    const report = selected.reportOnly ? await readLegacyImportReport(plan, { db: prisma }) : await executeLegacyImport(plan, { db: prisma });
    const reportPath = publishLegacyImportReport(report, { path: selected.reportPath });
    return { namespace: plan.namespace, sourceSha256: plan.sourceSha256, targetGenerationId: plan.generationUuid, counts: report.counts, reportPath, reportOnly: selected.reportOnly };
  } catch (error) { primary = error; throw error; }
  finally {
    if (prisma) {
      try { await prisma.$disconnect(); }
      catch (cleanup) { if (primary) throw new AggregateError([primary, cleanup], 'Legacy import failed and database disconnect also failed'); throw cleanup; }
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  // This local process fence never asserts a timed-out transaction rolled back.
  // An independently admitted operator must reconcile server sessions/receipts
  // before any subsequent invocation after timeout or uncertain acknowledgement.
  const started = performance.now();
  const deadlineExceeded = () => { console.error('Legacy import deadline exceeded; commit outcome uncertain. Reconcile owned database sessions and durable receipts before retry.'); process.exit(124); };
  let timer = setTimeout(deadlineExceeded, DEFAULT_LIMITS.maxDurationMs);
  main(process.argv.slice(2), process.env, { onAdmittedPlan(duration) {
    const remaining = duration - (performance.now() - started);
    clearTimeout(timer);
    if (remaining <= 0) deadlineExceeded();
    timer = setTimeout(deadlineExceeded, remaining);
  } }).then((result) => { console.log(JSON.stringify(result, null, 2)); }, (error) => {
    // Only known local validation messages are safe to expose. Database and
    // filesystem errors may contain credentials, raw inputs or private paths.
    if (/^(?:Legacy import (?:requires|plan refused:|conflict:)|Production legacy import requires|LEGACY_SOURCE_EXPORT_SHA256 does not match)/.test(error?.message ?? '')) console.error(error.message);
    console.error('Legacy import refused or failed; no automatic retry. Preserve private evidence and reconcile durable receipts before another invocation.'); process.exitCode = 1;
  }).finally(() => { clearTimeout(timer); });
}
