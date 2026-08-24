import { resolve } from 'node:path';
import { readInternalCiSourceContext } from './internal-ci-source-context.mjs';
import { writeExclusiveJson } from './internal-ci-evidence.mjs';

const args = process.argv.slice(2);
const one = (flag) => { const index = args.indexOf(flag); return index < 0 ? '' : args[index + 1] ?? ''; };
const name = one('--name'), contextPath = resolve(one('--source-context')), output = resolve(one('--output')), startedAt = one('--started-at');
const context = readInternalCiSourceContext(contextPath);
const attempt = Number(process.env.CI_RUN_ATTEMPT ?? '');
const started = Date.parse(startedAt), completedAt = new Date().toISOString();
if (!name || attempt !== 1 || !Number.isFinite(started) || started >= Date.parse(completedAt)) throw new Error('Invalid successful command result identity.');
writeExclusiveJson(output, { version: 1, kind: 'lunchlineup-internal-ci-command-result', name, status: 'passed', repository: context.repository, runId: context.runId, sourceSha: context.sourceSha, treeSha: context.treeSha, attempt, exitCode: 0, startedAt, completedAt }, { root: context.evidenceRoot });
