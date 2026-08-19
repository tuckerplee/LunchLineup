import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const requiredInteractionProofCases = new Map([
  ['interaction-desktop', [
    'click, slight movement, outside drop, Escape, and pointercancel issue no move request',
    'valid drag announces and commits the exact proposed employee and time with local Saved and Undo when exposed',
    'failed move restores only that shift and keyboard editing remains an exact fallback',
    'overnight values survive Calendar and Lunch while Lunch and Time Cards expose only supported explicit actions',
  ]],
  ['interaction-touch', [
    'real touch scroll never moves a shift and the dedicated handle opens the Move fallback',
  ]],
]);

function fail(message) {
  throw new Error(`Internal beta interaction proof rejected: ${message}`);
}

function collectSpecs(suites, output = []) {
  for (const suite of suites ?? []) {
    output.push(...(suite.specs ?? []));
    collectSpecs(suite.suites, output);
  }
  return output;
}

export function verifyInteractionProofReport(report, sourceSha) {
  if (!/^[a-f0-9]{40}$/.test(sourceSha)) fail('source SHA must be an exact lowercase 40-character Git SHA.');
  if (!report || typeof report !== 'object' || Array.isArray(report)) fail('Playwright JSON report must be an object.');
  if (report.config?.metadata?.candidateSha !== sourceSha) fail('Playwright report candidate SHA does not match the requested source SHA.');
  const specs = collectSpecs(report.suites);
  const observed = [];
  for (const spec of specs) {
    for (const test of spec.tests ?? []) {
      const projectName = test.projectName;
      const title = spec.title;
      const results = test.results ?? [];
      if (test.expectedStatus === 'skipped' || (test.annotations ?? []).some((item) => ['skip', 'fixme'].includes(item.type))) {
        fail(`${projectName}: ${title} was declared skipped or fixme.`);
      }
      if (results.length !== 1 || results[0].status !== 'passed') {
        fail(`${projectName}: ${title} must have exactly one passed attempt.`);
      }
      observed.push(`${projectName}\n${title}`);
    }
  }
  const expected = [...requiredInteractionProofCases].flatMap(([project, titles]) => titles.map((title) => `${project}\n${title}`));
  if ([...observed].sort().join('\n') !== [...expected].sort().join('\n')) {
    fail(`case inventory must exactly match ${expected.length} required cases.`);
  }
  return {
    version: 1,
    kind: 'lunchlineup-internal-beta-interaction-proof',
    sourceSha,
    cases: Object.fromEntries([...requiredInteractionProofCases].map(([project, titles]) => [
      project,
      Object.fromEntries(titles.map((title) => [title, 'passed'])),
    ])),
    artifactPolicy: { trace: 'on', video: 'on', screenshot: 'on' },
  };
}

function argument(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || index === process.argv.length - 1) fail(`${name} is required.`);
  return process.argv[index + 1];
}

function run() {
  const reportPath = argument('--report');
  const sourceSha = argument('--source-sha');
  const outputPath = argument('--output');
  if (existsSync(outputPath)) fail('output path already exists.');
  const reportBytes = readFileSync(reportPath);
  const proof = verifyInteractionProofReport(JSON.parse(reportBytes.toString('utf8')), sourceSha);
  proof.playwrightReportSha256 = createHash('sha256').update(reportBytes).digest('hex');
  writeFileSync(outputPath, `${JSON.stringify(proof, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
  console.log(`internal_beta_interaction_proof_ok source_sha=${sourceSha} report_sha256=${proof.playwrightReportSha256}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    run();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
