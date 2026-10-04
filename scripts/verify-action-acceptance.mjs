import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, realpathSync } from 'node:fs';
import { dirname, relative, resolve, sep } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Parse declarations without importing application modules or starting a service.
const require = createRequire(new URL('../packages/api-contract/package.json', import.meta.url));
const ts = require('typescript');
const methods = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);
const kinds = new Set(['catalog', 'native-route', 'provider', 'worker', 'frontend', 'operational-gate']);
const implementations = new Set(['native', 'retained', 'external', 'frontend', 'operational']);
const browserManifests = ['.ci/development-browser-cases.json', '.ci/development-logout-cases.json', '.ci/development-staff-cases.json'];
const digest = value => createHash('sha256').update(value).digest('hex');
const key = value => `${value.method} ${value.path}`;
const nonempty = value => typeof value === 'string' && value.trim().length > 0;
function need(condition, message) {
  if (!condition) throw new Error(`Invalid action acceptance inventory: ${message}`);
}
function unique(values, label) {
  need(new Set(values).size === values.length, `duplicate ${label}`);
}
function unwrap(node) {
  while (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node)) node = node.expression;
  return node;
}
function literal(node) {
  return node && (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) ? node.text : undefined;
}
function parse(path, content) {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  need(source.parseDiagnostics.length === 0, `unparseable source ${path}`);
  return source;
}
function closedCatalogOwner(node, source) {
  let shadowed = false;
  visit(source, value => {
    if ((ts.isVariableDeclaration(value) || ts.isParameter(value) || ts.isBindingElement(value)) &&
      ts.isIdentifier(value.name) && value.name.text === 'APPLICATION_API_OPERATIONS') shadowed = true;
  });
  if (shadowed) return false;
  let loop = node.parent;
  while (loop && !ts.isForOfStatement(loop)) loop = loop.parent;
  if (!loop || !ts.isIdentifier(loop.expression) || loop.expression.text !== 'APPLICATION_API_OPERATIONS' ||
    !ts.isVariableDeclarationList(loop.initializer) || !(loop.initializer.flags & ts.NodeFlags.Const) ||
    loop.initializer.declarations.length !== 1 || !ts.isIdentifier(loop.initializer.declarations[0].name) || !ts.isBlock(loop.statement)) return false;
  const binding = loop.initializer.declarations[0].name.text;
  const [alias, skipNative, registration] = loop.statement.statements;
  if (loop.statement.statements.length !== 3 || !ts.isVariableStatement(alias) ||
    !(alias.declarationList.flags & ts.NodeFlags.Const) || alias.declarationList.declarations.length !== 1) return false;
  const declaration = alias.declarationList.declarations[0];
  if (!ts.isIdentifier(declaration.name) || declaration.name.text !== 'operation' ||
    !declaration.initializer || !ts.isIdentifier(declaration.initializer) || declaration.initializer.text !== binding) return false;
  if (!ts.isIfStatement(skipNative) || !ts.isContinueStatement(skipNative.thenStatement) || skipNative.elseStatement ||
    skipNative.expression.getText(source).replace(/\s/g, '') !== "operation.native&&operation.operationId!=='getCurrentSession'" ||
    !ts.isExpressionStatement(registration) || registration.expression !== node) return false;
  return source.statements.some(statement => ts.isImportDeclaration(statement) &&
    literal(statement.moduleSpecifier) === '@lunchlineup/api-contract' &&
    !statement.importClause?.isTypeOnly && statement.importClause?.namedBindings && ts.isNamedImports(statement.importClause.namedBindings) &&
    statement.importClause.namedBindings.elements.some(element => element.name.text === 'APPLICATION_API_OPERATIONS' &&
      !element.isTypeOnly && (element.propertyName === undefined || element.propertyName.text === 'APPLICATION_API_OPERATIONS')));
}
function visit(node, callback) {
  callback(node);
  ts.forEachChild(node, child => visit(child, callback));
}
function reader(root) {
  const base = realpathSync(root), pins = new Map();
  function read(path) {
    need(nonempty(path) && !path.includes('\\') && !path.startsWith('/') &&
      path.split('/').every(part => part && part !== '.' && part !== '..'), `nonportable source path ${path}`);
    const target = realpathSync(resolve(base, path));
    need(target.startsWith(base + sep), `source escapes checkout ${path}`);
    const bytes = readFileSync(target);
    pins.set(path, { path, bytes: bytes.length, sha256: digest(bytes) });
    return bytes.toString('utf8');
  }
  return { read, base, pins };
}
function catalogInventory(read) {
  const path = 'packages/api-contract/src/application.ts', source = parse(path, read(path));
  let array;
  visit(source, node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.name.text === 'APPLICATION_API_OPERATIONS') {
      need(!array, 'multiple application catalogs');
      array = node.initializer && unwrap(node.initializer);
    }
  });
  need(array && ts.isArrayLiteralExpression(array) && array.elements.length > 0, 'missing literal application catalog');
  const operations = array.elements.map(node => {
    need(ts.isObjectLiteralExpression(node), 'computed application operation');
    const fields = new Map();
    for (const property of node.properties) {
      need(ts.isPropertyAssignment(property) && ts.isIdentifier(property.name), 'computed catalog property');
      need(!fields.has(property.name.text), 'duplicate catalog property');
      fields.set(property.name.text, property.initializer);
    }
    const operation = Object.fromEntries(['operationId', 'method', 'path', 'tag'].map(name => [name, literal(fields.get(name))]));
    need(Object.values(operation).every(nonempty) && methods.has(operation.method) && operation.path.startsWith('/'), 'invalid catalog operation');
    if (fields.has('native')) need(fields.get('native').kind === ts.SyntaxKind.TrueKeyword, 'nonliteral native catalog flag');
    return { ...operation, native: fields.has('native'),
      sourceAnchor: { path, line: source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1 } };
  });
  unique(operations.map(value => value.operationId), 'catalog operation ID');
  unique(operations.map(key), 'catalog route');
  return operations;
}
function routeInventory(base, read) {
  const paths = [];
  function walk(directory) {
    for (const item of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const path = resolve(directory, item.name);
      if (item.isDirectory()) walk(path);
      else if (item.isFile() && item.name.endsWith('.ts') && !/\.(spec|test)\.ts$/.test(item.name)) paths.push(relative(base, path).split(sep).join('/'));
    }
  }
  walk(resolve(base, 'apps/api-v2/src'));
  const routes = [];
  let closedCatalogRegistrations = 0;
  for (const path of paths) {
    const source = parse(path, read(path));
    visit(source, node => {
      if (!ts.isCallExpression(node) || !ts.isPropertyAccessExpression(node.expression)) return;
      const { expression: receiver, name } = node.expression;
      if (!ts.isIdentifier(receiver) || !['app', 'metricsApp'].includes(receiver.text)) return;
      const method = name.text.toUpperCase();
      need(!['head', 'options', 'all'].includes(name.text), `unsupported route registration ${path}:${name.text}`);
      if (methods.has(method)) {
        const url = literal(node.arguments[0]);
        need(nonempty(url), `computed route ${path}:${source.getLineAndCharacterOfPosition(node.getStart()).line + 1}`);
        routes.push({ method, path: url, source: path, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
      } else if (name.text === 'route') {
        const options = node.arguments[0];
        need(options && ts.isObjectLiteralExpression(options), `computed route options ${path}`);
        need(options.properties.every(ts.isPropertyAssignment), `computed/spread route properties ${path}`);
        const fields = new Map(options.properties.map(property => [property.name.getText(source), property.initializer]));
        need(fields.size === options.properties.length, `duplicate route properties ${path}`);
        const fixedMethod = literal(fields.get('method')), fixedUrl = literal(fields.get('url'));
        if (fixedMethod && fixedUrl) {
          need(methods.has(fixedMethod), `unsupported route method ${path}`);
          routes.push({ method: fixedMethod, path: fixedUrl, source: path, line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1 });
        } else {
          // The sole declared dynamic registration is the closed application catalog.
          need(path === 'apps/api-v2/src/application/routes.ts' &&
            fields.get('method')?.getText(source) === 'operation.method' &&
            fields.get('url')?.getText(source) === '`/v2${operation.path}`' && closedCatalogOwner(node, source), `unresolved route registration ${path}`);
          closedCatalogRegistrations++;
        }
      }
    });
  }
  unique(routes.map(key), 'literal API-v2 route');
  need(closedCatalogRegistrations === 1, 'missing or repeated closed catalog registration');
  return routes;
}
function workflowInventory(read) {
  const content = read('docs/runbooks/2.0-workflow-acceptance.md');
  const ids = [...content.matchAll(/^\| (UX-\d{3}) \|/gm)].map(value => value[1]);
  unique(ids, 'workflow ID');
  need(Array.from({ length: 84 }, (_, i) => `UX-${String(i + 1).padStart(3, '0')}`).every(id => ids.includes(id)), 'original84 workflow ledger changed');
  return ids;
}
function browserInventory(read) {
  const cases = [];
  for (const path of browserManifests) {
    const manifest = JSON.parse(read(path));
    need(manifest.version === 1 && manifest.releaseQualified === false && manifest.lanes && typeof manifest.lanes === 'object', `browser manifest ${path}`);
    for (const [lane, entries] of Object.entries(manifest.lanes)) {
      need(Array.isArray(entries) && entries.length > 0, `browser lane ${path}:${lane}`);
      for (const entry of entries) {
        need(nonempty(entry.file) && nonempty(entry.project) && Array.isArray(entry.titlePath) && entry.titlePath.length > 0 && entry.titlePath.every(nonempty), 'browser case identity');
        const registrations = registeredLiteralCases(`apps/web/tests/e2e/${entry.file}`, read, true);
        need(registrations.some(value => JSON.stringify([entry.file, ...value.titlePath]) === JSON.stringify(entry.titlePath)),
          `selected browser titlePath is not a literal registration ${entry.file}`);
        cases.push({ manifest: path, lane, file: entry.file, project: entry.project, titlePath: entry.titlePath });
      }
    }
  }
  unique(cases.map(value => JSON.stringify(value)), 'browser selection');
  return cases;
}
function disabledOptions(node) {
  const options = node.arguments[1];
  return options && ts.isObjectLiteralExpression(options) && options.properties.some(property =>
    ts.isPropertyAssignment(property) && ['skip', 'only', 'todo'].includes(property.name.getText().replace(/['"]/g, '')) &&
    property.initializer.kind !== ts.SyntaxKind.FalseKeyword);
}
function registrationTitles(node, allowGenerated) {
  const fixed = literal(node.arguments[0]);
  if (fixed) return [fixed];
  const template = node.arguments[0];
  if (!allowGenerated || !template || !ts.isTemplateExpression(template)) return [];
  let loop = node.parent;
  while (loop && !ts.isForOfStatement(loop)) loop = loop.parent;
  if (!loop || !ts.isVariableDeclarationList(loop.initializer) || !(loop.initializer.flags & ts.NodeFlags.Const) ||
    loop.initializer.declarations.length !== 1 || !ts.isIdentifier(loop.initializer.declarations[0].name) || !ts.isBlock(loop.statement) ||
    loop.statement.statements.length !== 1 || !ts.isExpressionStatement(loop.statement.statements[0]) || loop.statement.statements[0].expression !== node) return [];
  const binding = loop.initializer.declarations[0].name.text, values = unwrap(loop.expression);
  if (!ts.isArrayLiteralExpression(values) || values.elements.length === 0 || values.elements.length > 100 ||
    !values.elements.every(value => literal(value) !== undefined) ||
    !template.templateSpans.every(span => ts.isIdentifier(span.expression) && span.expression.text === binding)) return [];
  return values.elements.map(value => template.head.text + template.templateSpans.map(span => literal(value) + span.literal.text).join(''));
}
function registeredLiteralCases(path, read, selectedBrowser = false, allowGenerated = selectedBrowser) {
  need(/\.(spec|test)\.(ts|tsx|mjs|js)$/.test(path) ||
    (selectedBrowser && path.startsWith('apps/web/tests/e2e/') && path.endsWith('.proof.ts')), `executable is not a test source ${path}`);
  const source = parse(path, read(path)), cases = [];
  visit(source, node => {
    if (!ts.isCallExpression(node)) return;
    const name = node.expression;
    if (ts.isIdentifier(name) && ['it', 'test'].includes(name.text)) {
      const titles = registrationTitles(node, allowGenerated);
      const callback = node.arguments[node.arguments.length - 1];
      let disabledAncestor = Boolean(disabledOptions(node));
      const suites = [];
      for (let parent = node.parent; parent; parent = parent.parent) {
        if (!ts.isCallExpression(parent)) continue;
        const expression = parent.expression.getText(source);
        if (/^(?:test|it|describe)(?:\.describe)?\.(?:skip|fixme|todo|only)(?:\(|$)/.test(expression)) disabledAncestor = true;
        if (/^(?:test|it|describe|test\.describe)(?:\.(?:serial|parallel))?$/.test(expression) && disabledOptions(parent)) disabledAncestor = true;
        if (/^(?:describe|test\.describe)(?:\.(?:serial|parallel))?$/.test(expression)) {
          const suite = literal(parent.arguments[0]);
          if (!suite) disabledAncestor = true; else suites.unshift(suite);
        }
      }
      if (callback && (ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && !disabledAncestor) {
        for (const title of titles) cases.push({ title, titlePath: [...suites, title] });
      }
    }
  });
  return cases;
}

export function verifyActionAcceptance(manifest, root) {
  need(manifest?.version === 1 && manifest.kind === 'lunchlineup-action-acceptance-plan' &&
    manifest.releaseQualified === false && manifest.acceptanceExecuted === false, 'plan identity or execution claim');
  const { read, base, pins } = reader(root);
  const catalog = catalogInventory(read), routes = routeInventory(base, read), workflows = workflowInventory(read), browserCases = browserInventory(read);
  for (const operation of catalog.filter(value => value.native && value.operationId !== 'getCurrentSession')) {
    need(routes.some(value => key(value) === key({ method: operation.method, path: `/v2${operation.path}` })),
      `missing literal native catalog registration ${operation.operationId}`);
  }
  need(Array.isArray(manifest.actions) && manifest.actions.length > 0, 'empty actions');
  unique(manifest.actions.map(value => value.id), 'action ID');
  const catalogById = new Map(catalog.map(value => [value.operationId, value]));
  const catalogActions = manifest.actions.filter(value => value.kind === 'catalog');
  need(catalogActions.length === catalog.length && catalogActions.every(value => catalogById.has(value.id)), 'catalog actions differ from current catalog');
  const anchoredTitles = new Map(), mappedWorkflows = new Set(), declaredRoutes = new Set();
  let scenarios = 0, references = 0;
  for (const action of manifest.actions) {
    need(nonempty(action.id) && kinds.has(action.kind) && implementations.has(action.implementation) && action.status === 'pending', `invalid or accepted action ${action.id}`);
    for (const name of ['tag', 'actorBoundary', 'successContract', 'failureContract']) need(nonempty(action[name]), `missing ${name} ${action.id}`);
    need(Array.isArray(action.requiredEvidence) && action.requiredEvidence.length > 0 && action.requiredEvidence.every(nonempty), `missing required evidence ${action.id}`);
    unique(action.requiredEvidence, `required evidence ${action.id}`);
    need(Array.isArray(action.sourceAnchors) && action.sourceAnchors.length > 0, `missing source anchors ${action.id}`);
    for (const anchor of action.sourceAnchors) {
      const lines = read(anchor.path).split('\n');
      need(Number.isSafeInteger(anchor.line) && anchor.line > 0 && anchor.line <= lines.length, `invalid source anchor ${action.id}`);
      if (anchor.sourceLine !== undefined) need(anchor.sourceLine === lines[anchor.line - 1].replace(/\r$/, ''), `source anchor drift ${action.id}`);
    }
    need(Array.isArray(action.workflowIds) && action.workflowIds.every(id => workflows.includes(id)), `unknown workflow ${action.id}`);
    unique(action.workflowIds, `workflow association ${action.id}`);
    action.workflowIds.forEach(id => mappedWorkflows.add(id));
    if (action.kind === 'catalog') {
      const actual = catalogById.get(action.id);
      // A literal line can exist while describing a different operation.
      // Bind the anchor to the declaration selected by this operation's ID.
      const catalogAnchors = action.sourceAnchors.filter(anchor => anchor.path === actual.sourceAnchor.path);
      need(catalogAnchors.length === 1 && catalogAnchors[0].line === actual.sourceAnchor.line,
        `catalog operation anchor drift ${action.id}`);
      need(action.method === actual.method && action.path === actual.path && action.tag === actual.tag &&
        action.implementation === (actual.native ? 'native' : 'retained'), `catalog route or owner drift ${action.id}`);
      declaredRoutes.add(key({ method: action.method, path: `/v2${action.path}` }));
    } else if (action.kind === 'native-route') {
      need(methods.has(action.method) && nonempty(action.path), `missing native route ${action.id}`);
      const routeKey = key(action);
      need(routes.some(value => key(value) === routeKey) && !declaredRoutes.has(routeKey) &&
        !catalog.some(value => key({ method: value.method, path: `/v2${value.path}` }) === routeKey), `unknown or duplicate native route ${action.id}`);
      declaredRoutes.add(routeKey);
    }
    need(Array.isArray(action.scenarios) && action.scenarios.length > 0, `missing scenarios ${action.id}`);
    unique(action.scenarios.map(value => value.id), `scenario ID ${action.id}`);
    for (const scenario of action.scenarios) {
      scenarios++;
      need(nonempty(scenario.id) && nonempty(scenario.contract) && nonempty(scenario.evidenceKind), `invalid scenario ${action.id}`);
      if (scenario.executable !== undefined) {
        const { path, title } = scenario.executable;
        need(nonempty(title), `missing literal test title ${action.id}`);
        if (!anchoredTitles.has(path)) anchoredTitles.set(path, new Set(registeredLiteralCases(path, read,
          browserCases.some(value => path === `apps/web/tests/e2e/${value.file}`), false).map(value => value.title)));
        need(anchoredTitles.get(path).has(title), `test title is not a literal registration ${action.id}: ${title}`);
        references++;
      }
    }
  }
  const missingRoutes = routes.filter(value => !declaredRoutes.has(key(value)));
  need(missingRoutes.length === 0, `unmapped API-v2 routes: ${missingRoutes.map(key).join(', ')}`);
  const caseKey = value => JSON.stringify([value.manifest, value.lane, value.file, value.project, value.titlePath]);
  need(Array.isArray(manifest.browserCases) && JSON.stringify(manifest.browserCases.map(caseKey).sort()) ===
    JSON.stringify(browserCases.map(caseKey).sort()), 'browser selections differ from current manifests');
  return {
    kind: 'action-acceptance-source-inventory', releaseQualified: false, acceptanceExecuted: false,
    catalogOperations: catalog.length, literalApiV2Routes: routes.length, actions: manifest.actions.length,
    plannedScenarios: scenarios, scenariosWithLiteralTestReference: references,
    scenariosWithoutExecutableReference: scenarios - references, pendingActions: manifest.actions.length,
    originalWorkflows: 84, workflowRows: workflows.length, workflowsWithoutMappedAction: workflows.filter(id => !mappedWorkflows.has(id)),
    selectedBrowserCases: browserCases.length,
    limits: ['Static declarations and references are not execution or acceptance evidence.',
      'API-v2 inventory covers literal app/metricsApp registrations and the closed application catalog; other ingress, workers, frontend and operational gates require reviewed explicit contracts.',
      'Literal test registration establishes an existing source target, not assertion fidelity, selection or a passing result.'],
    sourcePins: [...pins.values()].sort((a, b) => a.path.localeCompare(b.path)),
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [manifestPath, rootPath] = process.argv.slice(2);
  need(process.argv.length === 4, 'usage: node scripts/verify-action-acceptance.mjs MANIFEST CHECKOUT');
  const root = rootPath || resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const bytes = readFileSync(manifestPath);
  console.log(JSON.stringify({ ...verifyActionAcceptance(JSON.parse(bytes), root), manifestSha256: digest(bytes) }, null, 2));
}
