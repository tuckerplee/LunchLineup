import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { verifyActionAcceptance } from './verify-action-acceptance.mjs';

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'll-action-inventory-'));
  const write = (path, content) => { mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), content); };
  const catalog = `throw new Error('Application code must never execute');
    export const APPLICATION_API_OPERATIONS = [
      { operationId: 'listLocations', method: 'GET', path: '/locations', tag: 'Locations', summary: 'List', native: true },
      { operationId: 'requestPasswordReset', method: 'POST', path: '/auth/password/reset/request', tag: 'Authentication', summary: 'Recover' },
    ] as const satisfies readonly ApplicationApiOperation[];`;
  write('packages/api-contract/src/application.ts', catalog);
  const routePath = 'apps/api-v2/src/locations/routes.ts';
  const routeSource = `app.get<{ Querystring: Query }>('/v2/locations', {}, async () => {});
    app.post('/v2/scheduling/drafts', {}, async () => {});`;
  write(routePath, routeSource);
  const registrarPath = 'apps/api-v2/src/application/routes.ts';
  const registrarSource = `import { APPLICATION_API_OPERATIONS } from '@lunchlineup/api-contract';
    for (const catalogOperation of APPLICATION_API_OPERATIONS) {
      const operation: ApplicationApiOperation = catalogOperation;
      if (operation.native && operation.operationId !== 'getCurrentSession') continue;
      app.route({ method: operation.method, url: \`/v2\${operation.path}\`, handler: handler });
    }`;
  write(registrarPath, registrarSource);
  write('docs/runbooks/2.0-workflow-acceptance.md', Array.from({ length: 84 }, (_, i) => `| UX-${String(i + 1).padStart(3, '0')} | Area | Workflow | Pending | Not executed |`).join('\n'));
  const browserCases = [];
  for (const path of ['.ci/development-browser-cases.json', '.ci/development-logout-cases.json', '.ci/development-staff-cases.json']) {
    const entry = { file: 'actions.spec.ts', project: 'chromium', titlePath: ['actions.spec.ts', path, 'observes the saved action'] };
    write(path, JSON.stringify({ version: 1, releaseQualified: false, lanes: { fullstack: [entry] } }));
    browserCases.push({ manifest: path, lane: 'fullstack', ...entry });
  }
  const browserTestPath = 'apps/web/tests/e2e/actions.spec.ts';
  write(browserTestPath, browserCases.map(value => `test.describe(${JSON.stringify(value.manifest)}, () => {
    test('observes the saved action', async () => {});
  });`).join('\n'));
  const testPath = 'scripts/actions.test.mjs';
  write(testPath, `test('observes the saved action', async () => {});`);
  const action = (id, kind, method, path, tag, implementation) => ({
    id, kind, method, path, tag, implementation, status: 'pending',
    sourceAnchors: [{ path: routePath, line: 1 }, ...(kind === 'catalog' ? [{
      path: 'packages/api-contract/src/application.ts',
      line: catalog.split('\n').findIndex(line => line.includes(`operationId: '${id}'`)) + 1,
    }] : [])], actorBoundary: 'Authenticated tenant identity',
    successContract: 'Read persisted tenant-scoped results independently', failureContract: 'Foreign tenant request leaves state unchanged',
    requiredEvidence: ['native-api', 'browser'], workflowIds: ['UX-001'],
    scenarios: [{ id: `${id}.readback`, contract: 'Independent readback with exact tenant identity', evidenceKind: 'browser',
      executable: { path: testPath, title: 'observes the saved action' } }],
  });
  const manifest = { version: 1, kind: 'lunchlineup-action-acceptance-plan', releaseQualified: false, acceptanceExecuted: false,
    browserCases, actions: [action('listLocations', 'catalog', 'GET', '/locations', 'Locations', 'native'),
      action('requestPasswordReset', 'catalog', 'POST', '/auth/password/reset/request', 'Authentication', 'retained'),
      action('native.createDraft', 'native-route', 'POST', '/v2/scheduling/drafts', 'Operations', 'retained')] };
  return { root, write, manifest, catalog, routePath, routeSource, registrarPath, registrarSource, testPath, browserTestPath, close: () => rmSync(root, { recursive: true, force: true }) };
}
function check(name, operation) {
  test(name, () => { const h = fixture(); try { operation(h); } finally { h.close(); } });
}

check('reports declaration gaps and pending actions without executing application source', h => {
  const proof = verifyActionAcceptance(h.manifest, h.root);
  assert.equal(proof.catalogOperations, 2); assert.equal(proof.literalApiV2Routes, 2);
  assert.equal(proof.pendingActions, 3); assert.equal(proof.acceptanceExecuted, false); assert.equal(proof.releaseQualified, false);
  assert.equal(proof.workflowsWithoutMappedAction.length, 83); assert.equal(proof.selectedBrowserCases, 3);
  assert.ok(proof.sourcePins.every(pin => /^[a-f0-9]{64}$/.test(pin.sha256)));
});
check('rejects a removed exposed catalog action', h => {
  h.manifest.actions.splice(1, 1); assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /catalog actions differ/);
});
check('rejects an additional catalog route until its action contract exists', h => {
  h.write('packages/api-contract/src/application.ts', h.catalog.replace('] as const', "{ operationId: 'newAction', method: 'POST', path: '/new', tag: 'People', summary: 'New' }, ] as const"));
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /catalog actions differ/);
});
check('rejects catalog method and native owner drift', h => {
  h.manifest.actions[0].implementation = 'retained'; assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /route or owner drift/);
  h.manifest.actions[0].implementation = 'native'; h.manifest.actions[0].method = 'POST';
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /route or owner drift/);
});
check('rejects an omitted extra scheduling route', h => {
  h.manifest.actions.pop(); assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unmapped API-v2 routes.*scheduling\/drafts/);
});
check('detects a native catalog declaration whose actual route was removed', h => {
  h.write(h.routePath, "app.post('/v2/scheduling/drafts', handler);");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /missing literal native catalog registration/);
});
check('detects loss of the closed retained catalog registrar', h => {
  h.write('apps/api-v2/src/application/routes.ts', '// Retained registrar removed');
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /missing or repeated closed catalog registration/);
});
check('refuses empty filtered or unrelated catalog iterables and wrong operation aliases', h => {
  for (const loop of ['[]', 'OTHER_OPERATIONS', 'APPLICATION_API_OPERATIONS.filter(() => false)']) {
    h.write(h.registrarPath, h.registrarSource.replace('of APPLICATION_API_OPERATIONS', `of ${loop}`));
    assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
  }
  h.write(h.registrarPath, h.registrarSource.replace('= catalogOperation;', '= unrelated;'));
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
});
check('refuses new conditional filters or missing catalog import in the closed registrar', h => {
  h.write(h.registrarPath, h.registrarSource.replace('app.route', "if (operation.tag === 'People') continue; app.route"));
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
  h.write(h.registrarPath, h.registrarSource.replace("import { APPLICATION_API_OPERATIONS } from '@lunchlineup/api-contract';", ''));
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
});
check('refuses local shadowing or a type-only import of the canonical catalog', h => {
  h.write(h.registrarPath, h.registrarSource.replace('for (const', 'function register(APPLICATION_API_OPERATIONS) { for (const') + '}');
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
  h.write(h.registrarPath, h.registrarSource.replace('import {', 'import type {'));
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
});
check('detects a newly declared API-v2 route independently of the catalog', h => {
  h.write(h.routePath, h.routeSource + "\napp.delete('/v2/scheduling/drafts/:draftId', {}, handler);");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unmapped API-v2 routes.*DELETE/);
});
check('rejects unknown and duplicate API-v2 route contracts', h => {
  h.manifest.actions[2].path = '/v2/missing'; assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unknown or duplicate native route/);
  h.manifest.actions[2].path = '/v2/locations'; h.manifest.actions[2].method = 'GET';
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unknown or duplicate native route/);
});
check('refuses computed native paths and spread registration options', h => {
  h.write(h.routePath, h.routeSource + '\napp.post(variablePath, options, handler);');
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /computed route/);
  h.write(h.routePath, h.routeSource + "\napp.route({ method: 'POST', url: '/v2/hidden', ...hidden });");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /spread route properties/);
});
check('refuses other unresolved dynamic app.route registrations', h => {
  h.write(h.routePath, h.routeSource + '\napp.route({ method: operation.method, url: operation.path });');
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unresolved route registration/);
});
check('detects metrics receiver routes as separate acceptance actions', h => {
  h.write('apps/api-v2/src/platform/metrics.ts', "metricsApp.get('/metrics', handler);");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unmapped API-v2 routes.*metrics/);
});
check('requires review for unsupported HEAD OPTIONS and wildcard registrations', h => {
  for (const method of ['head', 'options', 'all']) {
    h.write(h.routePath, h.routeSource + `\napp.${method}('/v2/unlisted', handler);`);
    assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unsupported route registration/);
  }
});
check('refuses accepted status, qualification and execution claims in a plan', h => {
  h.manifest.actions[0].status = 'passed'; assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /accepted action/);
  h.manifest.actions[0].status = 'pending'; h.manifest.releaseQualified = true;
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /execution claim/);
  h.manifest.releaseQualified = false; h.manifest.acceptanceExecuted = true;
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /execution claim/);
});
check('refuses a body string or skipped case as an executable registration', h => {
  h.write(h.testPath, "test('another action', async () => { const label = 'observes the saved action'; });");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
  h.write(h.testPath, "test.skip('observes the saved action', async () => {});");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
});
check('does not accept literal cases inside skipped or focused suites', h => {
  for (const registration of ['test.describe.skip', 'describe.only']) {
    h.write(h.testPath, `${registration}('disabled suite', () => { test('observes the saved action', async () => {}); });`);
    assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
  }
});
check('refuses plain Node skipped focused and todo options on cases or suites', h => {
  for (const option of ['skip', 'only', 'todo']) {
    h.write(h.testPath, `test('observes the saved action', { ${option}: true }, async () => {});`);
    assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
    h.write(h.testPath, `describe('disabled suite', { ${option}: true }, () => { test('observes the saved action', async () => {}); });`);
    assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
  }
});
check('does not accept a string argument with no test callback', h => {
  h.write(h.testPath, "test('observes the saved action', { only: false });");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
});
check('refuses selected registrations inside option-disabled Node test callbacks', h => {
  for (const parent of ['test', 'it']) {
    for (const option of ['skip', 'only', 'todo']) {
      h.write(h.testPath, `${parent}('outer', { ${option}: true }, () => { test('observes the saved action', async () => {}); });`);
      assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /not a literal registration/);
    }
  }
  h.write(h.testPath, "test('outer', { skip: false, only: false, todo: false }, () => { test('observes the saved action', async () => {}); });");
  assert.equal(verifyActionAcceptance(h.manifest, h.root).pendingActions, 3);
});
check('reports intentionally missing executable targets as gaps', h => {
  delete h.manifest.actions[0].scenarios[0].executable;
  const proof = verifyActionAcceptance(h.manifest, h.root); assert.equal(proof.scenariosWithoutExecutableReference, 1);
  assert.equal(proof.pendingActions, 3); assert.equal(proof.releaseQualified, false);
});
check('rejects browser manifest drift instead of retaining stale selected counts', h => {
  h.manifest.browserCases.pop(); assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /browser selections differ/);
});
check('compares browser identities independently of JSON property order', h => {
  h.manifest.browserCases = h.manifest.browserCases.map(({ titlePath, project, file, lane, manifest }) => ({ titlePath, project, file, lane, manifest }));
  assert.equal(verifyActionAcceptance(h.manifest, h.root).selectedBrowserCases, 3);
});
check('rejects stale selected browser titles whose test was removed', h => {
  h.write(h.browserTestPath, "test('different browser action', async () => {});");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /selected browser titlePath is not a literal registration/);
});
check('rejects changed browser suite ancestry even when another suite retains the leaf title', h => {
  h.write(h.browserTestPath, "test.describe('different suite', () => { test('observes the saved action', async () => {}); });");
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /selected browser titlePath is not a literal registration/);
});
check('accepts reviewed selected proof.ts cases and their explicit literal references', h => {
  const file = 'interaction.proof.ts'; h.manifest.browserCases[0].file = file;
  h.manifest.browserCases[0].titlePath = [file, 'proof suite', 'observes the saved action'];
  h.write('.ci/development-browser-cases.json', JSON.stringify({ version: 1, releaseQualified: false,
    lanes: { fullstack: [{ file, project: 'chromium', titlePath: h.manifest.browserCases[0].titlePath }] } }));
  const path = `apps/web/tests/e2e/${file}`;
  h.write(path, "test.describe('proof suite', () => { test('observes the saved action', async () => {}); });");
  h.manifest.actions[0].scenarios[0].executable.path = path;
  assert.equal(verifyActionAcceptance(h.manifest, h.root).selectedBrowserCases, 3);
});
check('does not treat an unselected proof source as an executable target', h => {
  const path = 'apps/web/tests/e2e/unselected.proof.ts'; h.write(path, "test('observes the saved action', async () => {});");
  h.manifest.actions[0].scenarios[0].executable.path = path;
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /executable is not a test source/);
});
check('resolves selected browser templates only from a bounded literal const loop', h => {
  const original = h.manifest.browserCases[0];
  const selected = ['general', 'team', 'security'].map(section => ({ ...original,
    titlePath: [original.file, original.manifest, `confirms ${section} changes`] }));
  h.manifest.browserCases.splice(0, 1, ...selected);
  h.write('.ci/development-browser-cases.json', JSON.stringify({ version: 1, releaseQualified: false,
    lanes: { fullstack: selected.map(({ manifest, lane, ...value }) => value) } }));
  const base = h.manifest.browserCases.slice(3).map(value => `test.describe(${JSON.stringify(value.manifest)}, () => {
    test('observes the saved action', async () => {});
  });`).join('\n');
  const generated = `test.describe(${JSON.stringify(original.manifest)}, () => {
    for (const section of ['general', 'team', 'security'] as const) {
      test(\`confirms \${section} changes\`, async () => {});
    }
  });`;
  h.write(h.browserTestPath, generated + base);
  assert.equal(verifyActionAcceptance(h.manifest, h.root).selectedBrowserCases, 5);
  h.write(h.browserTestPath, generated.replace("['general', 'team', 'security'] as const", 'unknownSections') + base);
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /selected browser titlePath is not a literal registration/);
  h.write(h.browserTestPath, generated.replace('test(`confirms', "if (section === 'security') continue; test(`confirms") + base);
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /selected browser titlePath is not a literal registration/);
});
check('preserves all84 workflows and rejects unknown workflow associations', h => {
  h.manifest.actions[0].workflowIds = ['UX-085']; assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /unknown workflow/);
  h.manifest.actions[0].workflowIds = ['UX-001']; h.write('docs/runbooks/2.0-workflow-acceptance.md', '| UX-001 | Only one |');
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /original84 workflow ledger changed/);
});
check('permits added workflows while preserving the original minimum', h => {
  const rows = Array.from({ length: 85 }, (_, i) => `| UX-${String(i + 1).padStart(3, '0')} | Area | Workflow | Pending | Not executed |`).join('\n');
  h.write('docs/runbooks/2.0-workflow-acceptance.md', rows); h.manifest.actions[0].workflowIds = ['UX-085'];
  const proof = verifyActionAcceptance(h.manifest, h.root); assert.equal(proof.originalWorkflows, 84); assert.equal(proof.workflowRows, 85);
});
check('rejects source paths and symlinks that escape the checkout', h => {
  h.manifest.actions[0].sourceAnchors[0].path = '../outside';
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /nonportable source path/);
  const external = mkdtempSync(join(tmpdir(), 'll-action-outside-'));
  try {
    writeFileSync(join(external, 'source.ts'), 'outside'); symlinkSync(join(external, 'source.ts'), join(h.root, 'outside.ts'));
    h.manifest.actions[0].sourceAnchors[0].path = 'outside.ts';
    assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /source escapes checkout/);
  } finally { rmSync(external, { recursive: true, force: true }); }
});
check('rejects duplicate action and scenario identities and nonexistent source lines', h => {
  h.manifest.actions.push(structuredClone(h.manifest.actions[0])); assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /duplicate action ID/);
  h.manifest.actions.pop(); h.manifest.actions[0].scenarios.push(structuredClone(h.manifest.actions[0].scenarios[0]));
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /duplicate scenario ID/);
  h.manifest.actions[0].scenarios.pop(); h.manifest.actions[0].sourceAnchors[0].line = 999;
  assert.throws(() => verifyActionAcceptance(h.manifest, h.root), /invalid source anchor/);
});
