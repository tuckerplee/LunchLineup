import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { readRegularEvidenceSnapshot, writeExclusiveJson } from './internal-ci-evidence.mjs';
const args=process.argv.slice(2); const one=(flag)=>{const i=args.indexOf(flag);return i<0?'':args[i+1]??'';};
const context=readInternalCiSourceContext(resolve(one('--source-context'))), mode=one('--mode'), scannerImage=one('--scanner-image'), reportPath=resolve(one('--report')), detailsPath=resolve(one('--details'));
if(!['full','delta'].includes(mode)||!/^semgrep\/semgrep:1\.169\.0@sha256:[a-f0-9]{64}$/.test(scannerImage)) throw new Error('Invalid Semgrep verification arguments.');
const snapshot=readRegularEvidenceSnapshot(reportPath,context.evidenceRoot), sarif=JSON.parse(snapshot.bytes.toString('utf8'));
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
// Semgrep 1.169.0's SARIF formatter emits these fields even with zero results.
// This validates its report contract, not arbitrary SARIF producer extensions.
if (!object(sarif) || sarif.version !== '2.1.0' || !Array.isArray(sarif.runs) || sarif.runs.length === 0) throw new Error('Invalid Semgrep SARIF report.');
let findings = 0;
for (const run of sarif.runs) {
  const driver = run?.tool?.driver;
  if (!object(run) || !object(driver) || !['Semgrep OSS', 'Semgrep PRO'].includes(driver.name) || driver.semanticVersion !== '1.169.0' || !Array.isArray(driver.rules) || !Array.isArray(run.results) || !Array.isArray(run.invocations) || run.invocations.length === 0) throw new Error('Incomplete Semgrep SARIF run.');
  const ruleIds = new Set();
  for (const rule of driver.rules) {
    if (!object(rule) || !text(rule.id) || ruleIds.has(rule.id)) throw new Error('Invalid Semgrep SARIF rule inventory.');
    ruleIds.add(rule.id);
  }
  for (const invocation of run.invocations) {
    if (!object(invocation) || invocation.executionSuccessful !== true || !Array.isArray(invocation.toolExecutionNotifications)) throw new Error('Semgrep SARIF execution failed.');
    // The pinned formatter sets executionSuccessful=true even when it emits
    // scanner errors here. Warnings/notes remain visible in retained evidence.
    for (const notification of invocation.toolExecutionNotifications) {
      if (!object(notification) || !['none', 'note', 'warning', 'error'].includes(notification.level) || !object(notification.message) || !text(notification.message.text) || notification.level === 'error') throw new Error('Semgrep SARIF execution notification failed.');
    }
  }
  for (const result of run.results) {
    if (!object(result) || !text(result.ruleId) || !ruleIds.has(result.ruleId) || !object(result.message) || !text(result.message.text)) throw new Error('Invalid Semgrep SARIF result.');
  }
  findings += run.results.length;
}
if (mode === 'delta' && findings !== 0) throw new Error('Semgrep delta findings must be zero.');
const details={sourceSha:context.sourceSha,treeSha:context.treeSha,scanner:'semgrep',scannerImage,findings,report:{path:snapshot.path,sha256:createHash('sha256').update(snapshot.bytes).digest('hex'),bytes:snapshot.bytes.length}}; if(mode==='delta') details.baselineSha=context.baselineSha;
writeExclusiveJson(detailsPath,details,{root:context.evidenceRoot});
