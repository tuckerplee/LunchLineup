import yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Observability in this repository is intentionally small. Alertmanager,
// Prometheus, Grafana, Loki, Alloy and backups are ESTATE systems; the app only
// exposes token-protected /metrics endpoints, writes container logs to the
// Docker json-file driver, and ships rule/target/dashboard files under
// docs/estate/ for estate-infra to copy. This verifier proves that shape.
export const OBSERVABILITY_FILES = Object.freeze({
  compose: 'docker-compose.yml',
  caddy: 'infrastructure/caddy/Caddyfile',
  caddyTemplate: 'infrastructure/caddy/Caddyfile.template',
  caddyPilot: 'infrastructure/caddy/Caddyfile.private-pilot',
  caddyProduction: 'infrastructure/caddy/Caddyfile.production',
  webContentSecurityPolicy: 'apps/web/lib/content-security-policy.ts',
  webProxy: 'apps/web/proxy.ts',
  webLayout: 'apps/web/app/layout.tsx',
  estateRules: 'docs/estate/lunchlineup-rules.yml',
  estateTargets: 'docs/estate/lunchlineup-targets.yml',
  estateRuleTestMain: 'docs/estate/tests/lunchlineup.test.yml',
  estateRuleTestNative: 'docs/estate/tests/native-api.test.yml',
  estateRuleTestDeletion: 'docs/estate/tests/tenant-deletion-billing.test.yml',
  platformDashboard: 'docs/estate/dashboards/platform-overview.json',
  deletionDashboard: 'docs/estate/dashboards/tenant-deletion-billing.json',
  publicWebProbe: 'infrastructure/control/public-web-probe.sh',
  publicWebProbeEnv: 'infrastructure/systemd/lunchlineup-public-web-probe.env.example',
  publicWebProbeService: 'infrastructure/systemd/lunchlineup-public-web-probe.service',
  publicWebProbeTimer: 'infrastructure/systemd/lunchlineup-public-web-probe.timer',
});

export const OBSERVABILITY_TOOL_IMAGES = Object.freeze({
  caddy: 'caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
  prometheus: 'prom/prometheus:v3.14.0-distroless@sha256:50c707e96da5ade383cb1707790576480485e93de06aa60ad8802cb5f744bd0a',
});

export const OBSERVABILITY_TOOL_MODES = Object.freeze(['off', 'auto', 'host', 'container']);
export const PROMETHEUS_RULE_TEST_FILES = Object.freeze([
  'docs/estate/tests/lunchlineup.test.yml',
  'docs/estate/tests/tenant-deletion-billing.test.yml',
  'docs/estate/tests/native-api.test.yml',
]);

// Compose services, volumes, networks and secrets that belong to estate systems
// and must never come back into the application stack.
export const REMOVED_SERVICES = Object.freeze([
  'prometheus', 'alertmanager', 'grafana', 'loki', 'promtail', 'tempo', 'otel-collector',
  'node-exporter', 'backup', 'pitr-base-backup', 'pitr-restore', 'pitr-wal-provider',
  'pitr-lifecycle-audit',
]);
export const REMOVED_VOLUMES = Object.freeze([
  'prometheus_data', 'alertmanager_data', 'loki_data', 'promtail_positions', 'tempo_data',
  'grafana_data', 'backup_data', 'pitr_staging', 'postgres_pitr_restore_data',
]);
export const REMOVED_NETWORKS = Object.freeze([
  'telemetry', 'alertmanager-egress', 'pitr-egress', 'pitr-wal-control',
]);
export const REMOVED_SECRETS = Object.freeze(['alertmanager_webhook_url', 'backup_encryption_key']);
export const METRICS_GATEWAY_PORT = 9180;
export const METRICS_GATEWAY_SERVICES = Object.freeze({
  // api checks the Host header (API_INTERNAL_HOSTS), so its route sends the upstream as Host.
  api: { upstream: 'api:3000', path: '/metrics', upstreamHost: true },
  'api-v2': { upstream: 'api-v2:3002', path: '/metrics' },
  worker: { upstream: 'worker:3003', path: '/metrics' },
  engine: { upstream: 'engine:8000', path: '/metrics' },
  'webhook-replay': { upstream: 'webhook-replay:3004', path: '/metrics' },
  control: { upstream: 'control:3001', path: '/api/metrics' },
});

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');
const durationPattern = /^(?:0|[1-9][0-9]*)(?:ms|s|m|h|d|w|y)$/;
const containerPaths = Object.freeze({
  caddyConfig: '/etc/caddy/Caddyfile',
  estateDir: '/etc/estate',
  estateRules: '/etc/estate/lunchlineup-rules.yml',
  estateRuleTestsDir: '/etc/estate/tests',
});
const toolVersionArgs = Object.freeze({
  caddy: ['version'],
  promtool: ['--version'],
});
const expectedAlerts = Object.freeze([
  'ServiceDown',
  'ExpectedScrapeTargetMissing',
  'NativeApiMetricsMissing',
  'NativeApiHttpInstrumentationUnavailable',
  'HighNativeApiErrorRate',
  'HighNativeApiLatency',
  'PublicWebUnavailable',
  'PublicWebProbeStale',
  'HighApiErrorRate',
  'HighApiLatency',
  'ApiAvailabilityBudgetFastBurn',
  'ApiAvailabilityBudgetSlowBurn',
  'PublicWebAvailabilityBudgetFastBurn',
  'PublicWebAvailabilityBudgetSlowBurn',
  'RequiredApiDependencyUnavailable',
  'WorkerJobFailures',
  'WebhookReplayNotReady',
  'WebhookReplayFailures',
  'SolverQueueBacklog',
  'SolverErrors',
  'DiskSpaceLow',
  'HostFilesystemTelemetryMissing',
  'RetentionPurgeTelemetryMissing',
  'RetentionPurgeStale',
  'ApplicationDataRetentionExecutionTelemetryMissing',
  'ApplicationDataRetentionExecutionStale',
  'RetentionPurgeFailed',
  'RetentionPurgeCandidatesReady',
  'TenantDeletionBillingBacklogSustained',
  'TenantDeletionBillingSweepStale',
]);
// Rules about removed in-stack components must not be reintroduced.
const forbiddenAlertPattern = /^(?:Backup|Pitr)/;

function addError(errors, message) {
  errors.push(message);
}

function expect(errors, condition, message) {
  if (!condition) {
    addError(errors, message);
  }
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function asMap(value) {
  return isObject(value) ? value : {};
}

function unique(values) {
  return [...new Set(values)];
}

function readText(root, relativePath, errors, checked) {
  const absolutePath = join(root, relativePath);
  checked.add(relativePath);
  try {
    return readFileSync(absolutePath, 'utf8');
  } catch (error) {
    addError(errors, `${relativePath}: cannot read file: ${error.message}`);
    return '';
  }
}

function readYaml(root, relativePath, errors, checked) {
  const content = readText(root, relativePath, errors, checked);
  if (!content) {
    return null;
  }

  try {
    return yaml.load(content, { filename: relativePath });
  } catch (error) {
    addError(errors, `${relativePath}: YAML parse failed: ${error.reason ?? error.message}`);
    return null;
  }
}

function commandSpec(command, args, options = {}) {
  return {
    command,
    args: args.map((arg) => String(arg)),
    env: options.env,
  };
}

function dockerVolume(root, relativePath, containerPath) {
  return `${join(root, relativePath)}:${containerPath}:ro`;
}

function quoteShellArg(arg) {
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(arg)) {
    return arg;
  }
  return `'${String(arg).replaceAll("'", "'\\''")}'`;
}

export function formatCommand(command) {
  return [command.command, ...command.args].map(quoteShellArg).join(' ');
}

function defaultToolRunner(command, args, options = {}) {
  return spawnSync(command, args, {
    cwd: options.cwd,
    encoding: 'utf8',
    env: options.env ?? process.env,
    timeout: options.timeoutMs ?? 180_000,
    windowsHide: true,
  });
}

function normalizeToolResult(result) {
  return {
    status: result?.status ?? (result?.error ? 127 : 0),
    stdout: String(result?.stdout ?? ''),
    stderr: String(result?.stderr ?? ''),
    error: result?.error,
  };
}

function resultOutput(result, abbreviated = false) {
  const lines = [result.stderr, result.stdout]
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .trim()
    .split(/\r?\n/);
  return (abbreviated ? lines.slice(0, 8) : lines).join(' | ');
}

function missingExecutable(result) {
  return result.error?.code === 'ENOENT';
}

function runToolCommand(command, root, runner) {
  return normalizeToolResult(runner(command.command, command.args, {
    cwd: root,
    env: command.env ? { ...process.env, ...command.env } : undefined,
  }));
}

function toolAvailable(tool, root, runner) {
  const command = commandSpec(tool, toolVersionArgs[tool] ?? ['--version']);
  const result = runToolCommand(command, root, runner);
  return !missingExecutable(result) && result.status === 0;
}
function commandFailure(check, command, result) {
  let retained = '';
  let retentionFailure = '';
  const directory = process.env.LUNCHLINEUP_OBSERVABILITY_DIAGNOSTICS_DIR;
  if (directory) {
    try {
      // The fixed owner harness supplies its existing preserved evidence directory.
      const destination = mkdtempSync(join(directory, 'observability-tool-'));
      writeFileSync(join(destination, 'stdout.log'), result.stdout, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(destination, 'stderr.log'), result.stderr, { flag: 'wx', mode: 0o600 });
      writeFileSync(join(destination, 'result.json'), JSON.stringify({
        version: 1, check: check.id, command: command.command, args: command.args,
        status: result.status, captureError: result.error ? {
          name: result.error.name, code: result.error.code, message: result.error.message,
        } : null,
        scope: 'unabridged captured UTF-8 output; upstream runner limits unchanged',
      }, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      retained = destination;
    } catch (error) {
      retentionFailure = `; diagnostic retention failed: ${error.message}`;
    }
  }
  // Never abbreviate unless both captured streams and their result were retained.
  const output = resultOutput(result, Boolean(retained));
  const suffix = (output ? `: ${output}` : '')
    + (retained ? `; captured output: ${retained}` : '')
    + (result.error ? `; capture error: ${result.error.code ?? result.error.name}: ${result.error.message}` : '')
    + retentionFailure;
  if (missingExecutable(result)) {
    return `${check.id}: ${command.command} was not found on PATH${suffix}`;
  }
  return `${check.id}: ${formatCommand(command)} exited ${result.status}${suffix}`;
}


export function buildObservabilityToolCommands(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const caddyChecks = [
    [OBSERVABILITY_FILES.caddy, 'active Caddyfile', 'config'],
    [OBSERVABILITY_FILES.caddyTemplate, 'template Caddyfile', 'template'],
    [OBSERVABILITY_FILES.caddyPilot, 'private pilot Caddyfile', 'private-pilot'],
    [OBSERVABILITY_FILES.caddyProduction, 'production Caddyfile', 'production'],
  ].map(([relativePath, label, suffix]) => ({
    id: `caddy-${suffix}`,
    tool: 'caddy',
    label,
    hostCommand: commandSpec('caddy', ['validate', '--config', join(root, relativePath), '--adapter', 'caddyfile']),
    containerCommand: commandSpec('docker', [
      'run',
      '--rm',
      '-v',
      dockerVolume(root, relativePath, containerPaths.caddyConfig),
      '--entrypoint',
      '/usr/bin/caddy',
      OBSERVABILITY_TOOL_IMAGES.caddy,
      'validate',
      '--config',
      containerPaths.caddyConfig,
      '--adapter',
      'caddyfile',
    ]),
  }));

  return [
    ...caddyChecks,
    {
      id: 'prometheus-rules',
      tool: 'promtool',
      label: 'Estate Prometheus alert rules',
      hostCommand: commandSpec('promtool', ['check', 'rules', join(root, OBSERVABILITY_FILES.estateRules)]),
      containerCommand: commandSpec('docker', [
        'run',
        '--rm',
        '-v',
        dockerVolume(root, 'docs/estate', containerPaths.estateDir),
        '--entrypoint',
        '/bin/promtool',
        OBSERVABILITY_TOOL_IMAGES.prometheus,
        'check',
        'rules',
        containerPaths.estateRules,
      ]),
    },
    {
      id: 'prometheus-rule-tests',
      tool: 'promtool',
      label: 'Estate Prometheus alert rule fixtures',
      hostCommand: commandSpec('promtool', [
        'test',
        'rules',
        ...PROMETHEUS_RULE_TEST_FILES.map((relativePath) => join(root, relativePath)),
      ]),
      containerCommand: commandSpec('docker', [
        'run',
        '--rm',
        '-v',
        dockerVolume(root, 'docs/estate', containerPaths.estateDir),
        '--workdir',
        containerPaths.estateRuleTestsDir,
        '--entrypoint',
        '/bin/promtool',
        OBSERVABILITY_TOOL_IMAGES.prometheus,
        'test',
        'rules',
        ...PROMETHEUS_RULE_TEST_FILES.map((relativePath) => basename(relativePath)),
      ]),
    },
  ];
}

export function validateObservabilityTools(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const mode = options.mode ?? 'off';
  if (!OBSERVABILITY_TOOL_MODES.includes(mode)) {
    throw new Error(`unknown tool mode: ${mode}`);
  }

  const errors = [];
  const checks = [];
  const skipped = [];
  const runner = options.runner ?? defaultToolRunner;
  const availability = new Map();
  const missingRequiredTools = new Set();

  if (mode === 'off') {
    return { ok: true, mode, root, errors, checks, skipped };
  }

  const isAvailable = (tool) => {
    if (!availability.has(tool)) {
      availability.set(tool, toolAvailable(tool, root, runner));
    }
    return availability.get(tool);
  };

  for (const check of buildObservabilityToolCommands({ root })) {
    if (mode === 'container') {
      const result = runToolCommand(check.containerCommand, root, runner);
      checks.push({
        id: check.id,
        label: check.label,
        mode,
        command: formatCommand(check.containerCommand),
        status: result.status,
      });
      if (result.status !== 0) {
        errors.push(commandFailure(check, check.containerCommand, result));
      }
      continue;
    }

    if (!isAvailable(check.tool)) {
      const skippedCheck = {
        id: check.id,
        label: check.label,
        tool: check.tool,
        reason: `${check.tool} was not found on PATH`,
        fallbackCommand: formatCommand(check.containerCommand),
      };
      skipped.push(skippedCheck);
      if (mode === 'host') {
        missingRequiredTools.add(check.tool);
      }
      continue;
    }

    try {
      const result = runToolCommand(check.hostCommand, root, runner);
      checks.push({
        id: check.id,
        label: check.label,
        mode: 'host',
        command: formatCommand(check.hostCommand),
        status: result.status,
      });
      if (result.status !== 0) {
        errors.push(commandFailure(check, check.hostCommand, result));
      }
    } catch (error) {
      errors.push(`${check.id}: ${error.message}`);
    }
  }

  for (const tool of missingRequiredTools) {
    errors.push(`${tool} is required for --tool-mode host; install it on PATH or use --tool-mode container`);
  }

  return {
    ok: errors.length === 0,
    mode,
    root,
    errors,
    checks,
    skipped,
  };
}


function hasDuration(value) {
  return typeof value === 'string' && durationPattern.test(value);
}

function environmentMap(environment) {
  if (Array.isArray(environment)) {
    return Object.fromEntries(
      environment.map((entry) => {
        const text = String(entry);
        const separator = text.indexOf('=');
        return separator === -1 ? [text, ''] : [text.slice(0, separator), text.slice(separator + 1)];
      }),
    );
  }

  return Object.fromEntries(Object.entries(asMap(environment)).map(([key, value]) => [key, String(value)]));
}

function listValue(value) {
  if (Array.isArray(value)) {
    return value;
  }

  if (isObject(value)) {
    return Object.keys(value);
  }

  if (typeof value === 'string') {
    return [value];
  }

  return [];
}

function parseVolume(volume) {
  if (typeof volume === 'string') {
    const parts = volume.split(':');
    return {
      source: parts[0],
      target: parts[1],
      mode: parts.slice(2).join(':'),
    };
  }

  if (isObject(volume)) {
    return {
      source: volume.source,
      target: volume.target,
      mode: volume.read_only === true ? 'ro' : volume.mode,
    };
  }

  return {};
}

function hasVolume(service, source, target, mode) {
  return asArray(service?.volumes).map(parseVolume).some((volume) => (
    volume.source === source
    && volume.target === target
    && (mode === undefined || String(volume.mode ?? '').split(',').includes(mode))
  ));
}

function hasSecret(service, secretName) {
  return asArray(service?.secrets).some((secret) => (
    secret === secretName || (isObject(secret) && (secret.source === secretName || secret.target === secretName))
  ));
}

function commandList(command) {
  return Array.isArray(command) ? command.map(String) : [String(command ?? '')];
}


function stripCaddyComment(line) {
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < line.length; index += 1) {
    const char = line[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      quoted = !quoted;
      continue;
    }
    if (char === '#' && !quoted) {
      return line.slice(0, index);
    }
  }
  return line;
}

function tokenizeCaddyLine(line, filePath, lineNumber, errors) {
  const tokens = [];
  let index = 0;

  while (index < line.length) {
    while (index < line.length && /\s/.test(line[index])) {
      index += 1;
    }
    if (index >= line.length) {
      break;
    }

    if (line[index] === '"') {
      let token = '';
      index += 1;
      let closed = false;
      while (index < line.length) {
        const char = line[index];
        if (char === '\\' && index + 1 < line.length) {
          token += line[index + 1];
          index += 2;
          continue;
        }
        if (char === '"') {
          closed = true;
          index += 1;
          break;
        }
        token += char;
        index += 1;
      }
      if (!closed) {
        addError(errors, `${filePath}:${lineNumber}: unterminated quoted token`);
      }
      tokens.push(token);
      continue;
    }

    if (line[index] === '{' && line[index + 1] === '$') {
      const start = index;
      const end = line.indexOf('}', index + 2);
      if (end === -1) {
        addError(errors, `${filePath}:${lineNumber}: unterminated environment placeholder`);
        tokens.push(line.slice(start));
        break;
      }
      tokens.push(line.slice(start, end + 1));
      index = end + 1;
      continue;
    }

    const start = index;
    while (index < line.length && !/\s/.test(line[index])) {
      index += 1;
    }
    tokens.push(line.slice(start, index));
  }

  return tokens;
}

function parseCaddyfile(content, filePath, errors) {
  const root = { name: '$root', args: [], children: [], line: 0 };
  const stack = [root];

  content.split(/\r?\n/).forEach((rawLine, lineIndex) => {
    const lineNumber = lineIndex + 1;
    const line = stripCaddyComment(rawLine).trim();
    if (!line) {
      return;
    }

    if (line === '}') {
      if (stack.length === 1) {
        addError(errors, `${filePath}:${lineNumber}: unexpected closing brace`);
        return;
      }
      stack.pop();
      return;
    }

    const parent = stack[stack.length - 1];
    if (line.endsWith('{')) {
      const header = line.slice(0, -1).trim();
      const tokens = header ? tokenizeCaddyLine(header, filePath, lineNumber, errors) : ['$global'];
      if (tokens.length === 0) {
        addError(errors, `${filePath}:${lineNumber}: block is missing a directive`);
        return;
      }
      const node = { name: tokens[0], args: tokens.slice(1), children: [], line: lineNumber };
      parent.children.push(node);
      stack.push(node);
      return;
    }

    const tokens = tokenizeCaddyLine(line, filePath, lineNumber, errors);
    if (tokens.length === 0) {
      return;
    }
    parent.children.push({ name: tokens[0], args: tokens.slice(1), children: [], line: lineNumber });
  });

  if (stack.length > 1) {
    const unclosed = stack.slice(1).map((node) => `${node.name} at line ${node.line}`).join(', ');
    addError(errors, `${filePath}: unclosed block(s): ${unclosed}`);
  }

  return root;
}

function childDirectives(parent, name) {
  return asArray(parent?.children).filter((child) => child.name === name);
}

function firstChild(parent, name) {
  return childDirectives(parent, name)[0];
}

function findHandle(site, routePath) {
  return childDirectives(site, 'handle').find((handle) => (
    routePath === undefined ? handle.args.length === 0 : handle.args[0] === routePath
  ));
}

function validateCaddyRoute(errors, filePath, site, routePath, expectedProxy, expectedStripPrefix, expectedRewrite) {
  const routeLabel = routePath ?? 'default';
  const handle = findHandle(site, routePath);
  expect(errors, handle, `${filePath}: missing ${routeLabel} handle`);
  if (!handle) {
    return;
  }

  const proxy = firstChild(handle, 'reverse_proxy');
  expect(errors, proxy?.args[0] === expectedProxy, `${filePath}: ${routeLabel} must reverse_proxy ${expectedProxy}`);

  if (expectedStripPrefix) {
    const uri = firstChild(handle, 'uri');
    expect(
      errors,
      uri?.args[0] === 'strip_prefix' && uri?.args[1] === expectedStripPrefix,
      `${filePath}: ${routeLabel} must strip_prefix ${expectedStripPrefix}`,
    );
  } else if (expectedRewrite) {
    const rewrite = firstChild(handle, 'rewrite');
    expect(
      errors,
      rewrite?.args[0] === '*' && rewrite?.args[1] === expectedRewrite,
      `${filePath}: ${routeLabel} must rewrite to ${expectedRewrite}`,
    );
    expect(errors, !firstChild(handle, 'uri'), `${filePath}: ${routeLabel} must not use a URI adapter`);
  } else {
    expect(errors, !firstChild(handle, 'uri'), `${filePath}: ${routeLabel} must not rewrite the URI`);
  }
}

function validateRetiredV1Route(errors, filePath, site) {
  const handle = findHandle(site, '/api/v1/*');
  expect(errors, handle, `${filePath}: missing terminal /api/v1/* retirement handle`);
  if (!handle) return;
  const response = firstChild(handle, 'respond');
  expect(
    errors,
    response?.args.includes('410') && response?.args.join(' ').includes('API version v1 has been retired.'),
    `${filePath}: /api/v1/* must return the terminal 410 retirement response`,
  );
  expect(errors, !firstChild(handle, 'reverse_proxy') && !firstChild(handle, 'uri'), `${filePath}: retired v1 route must not proxy upstream`);
}

function validateSecurityHeader(errors, filePath, headerBlock, headerName, predicate, description) {
  const directive = firstChild(headerBlock, headerName);
  expect(errors, directive, `${filePath}: missing ${headerName} header`);
  if (!directive) {
    return;
  }
  const value = directive.args.join(' ');
  expect(errors, predicate(value), `${filePath}: ${headerName} header must ${description}`);
}

function validateCaddyfile(root, relativePath, errors, checked) {
  const content = readText(root, relativePath, errors, checked);
  const parsed = parseCaddyfile(content, relativePath, errors);
  const globalBlocks = childDirectives(parsed, '$global');
  const siteBlocks = asArray(parsed.children).filter((node) => node.name.startsWith('{$CADDY_SITE_ADDRESSES:'));

  expect(errors, globalBlocks.length === 1, `${relativePath}: expected exactly one global options block`);
  const globalBlock = globalBlocks[0];
  const emailDirective = firstChild(globalBlock, 'email');
  expect(
    errors,
    emailDirective?.args[0]?.startsWith('{$ADMIN_EMAIL:'),
    `${relativePath}: global email must come from ADMIN_EMAIL with a fallback`,
  );

  expect(errors, siteBlocks.length === 1, `${relativePath}: expected exactly one CADDY_SITE_ADDRESSES site block`);
  const site = siteBlocks[0];
  if (!site) {
    return;
  }
  expect(errors, site.name.endsWith('}'), `${relativePath}: site address env placeholder must be closed`);
  expect(errors, site.name.length > '{$CADDY_SITE_ADDRESSES:}'.length, `${relativePath}: site address fallback is required`);

  const encode = firstChild(site, 'encode');
  expect(errors, encode?.args.includes('zstd') && encode?.args.includes('gzip'), `${relativePath}: encode must enable zstd and gzip`);

  const requestBody = firstChild(site, 'request_body');
  expect(errors, requestBody, `${relativePath}: request_body block is required`);
  expect(errors, firstChild(requestBody, 'max_size')?.args[0] === '10MB', `${relativePath}: request_body max_size must be 10MB`);

  const headerBlock = childDirectives(site, 'header').find((header) => header.args.length === 0);
  expect(errors, headerBlock, `${relativePath}: browser security header block is required`);
  if (headerBlock) {
    validateSecurityHeader(
      errors,
      relativePath,
      headerBlock,
      'Strict-Transport-Security',
      (value) => value === 'max-age=31536000; includeSubDomains; preload',
      'set the preload HSTS policy',
    );
    validateSecurityHeader(errors, relativePath, headerBlock, 'X-Content-Type-Options', (value) => value === 'nosniff', 'disable MIME sniffing');
    validateSecurityHeader(errors, relativePath, headerBlock, 'X-Frame-Options', (value) => value === 'DENY', 'deny framing');
    validateSecurityHeader(
      errors,
      relativePath,
      headerBlock,
      'Permissions-Policy',
      (value) => value === 'camera=(), microphone=(), geolocation=(), payment=()',
      'disable sensitive browser capabilities',
    );
    expect(errors, firstChild(headerBlock, '-Server'), `${relativePath}: Server header must be removed`);
  }

  const apiNoStore = childDirectives(site, 'header').find((header) => (
    header.args[0] === '/api/*'
    && header.args[1] === 'Cache-Control'
    && header.args[2] === 'no-store'
  ));
  expect(errors, apiNoStore, `${relativePath}: /api/* responses must set Cache-Control no-store`);

  validateCaddyRoute(errors, relativePath, site, '/health', 'api-v2:3002', undefined, '/v2/ready');
  validateCaddyRoute(errors, relativePath, site, '/api/health', 'api-v2:3002', undefined, '/v2/ready');
  validateRetiredV1Route(errors, relativePath, site);
  validateCaddyRoute(errors, relativePath, site, undefined, 'web:3000');

  const handles = childDirectives(site, 'handle');
  expect(errors, handles[handles.length - 1]?.args.length === 0, `${relativePath}: default web handle must remain last`);
}

function validateWebContentSecurityPolicy(root, errors, checked) {
  const policyPath = OBSERVABILITY_FILES.webContentSecurityPolicy;
  const proxyPath = OBSERVABILITY_FILES.webProxy;
  const layoutPath = OBSERVABILITY_FILES.webLayout;
  const policy = readText(root, policyPath, errors, checked);
  const proxy = readText(root, proxyPath, errors, checked);
  const layout = readText(root, layoutPath, errors, checked);

  const requiredPolicyTokens = [
    "randomBytes(16).toString('base64')",
    '/^[A-Za-z0-9+/]{22}==$/.test(nonce)',
    'https://challenges.cloudflare.com',
    'https://static.cloudflareinsights.com',
    'https://cloudflareinsights.com',
    '"default-src \'self\'"',
    '"object-src \'none\'"',
    '"frame-ancestors \'none\'"',
    "`script-src 'self' 'nonce-${nonce}' 'strict-dynamic'",
    '"script-src-attr \'none\'"',
    "['upgrade-insecure-requests']",
  ];
  for (const token of requiredPolicyTokens) {
    expect(errors, policy.includes(token), `${policyPath}: missing required CSP contract ${token}`);
  }
  expect(
    errors,
    !policy.match(/script-src[^\n]*unsafe-inline/),
    `${policyPath}: script-src must not allow unsafe-inline`,
  );

  const requiredProxyTokens = [
    "createContentSecurityPolicy()",
    "securedRequestHeaders.set('Content-Security-Policy', contentSecurityPolicy)",
    "securedRequestHeaders.set('x-nonce', nonce)",
    "response.headers.set('Content-Security-Policy', contentSecurityPolicy)",
    "(?!api(?:/|$)|_next/static|_next/image",
  ];
  for (const token of requiredProxyTokens) {
    expect(errors, proxy.includes(token), `${proxyPath}: missing required CSP integration ${token}`);
  }
  expect(
    errors,
    layout.includes("export const dynamic = 'force-dynamic'"),
    `${layoutPath}: nonce-backed pages must be force-dynamic`,
  );

  for (const caddyPath of [OBSERVABILITY_FILES.caddy, OBSERVABILITY_FILES.caddyTemplate]) {
    const caddy = readFileSync(join(root, caddyPath), 'utf8');
    expect(
      errors,
      !caddy.includes('Content-Security-Policy'),
      `${caddyPath}: CSP must have one owner in the nonce-aware web runtime`,
    );
  }
}


function validatePublicWebProbe(root, errors, checked) {
  const script = readText(root, OBSERVABILITY_FILES.publicWebProbe, errors, checked);
  const environment = readText(root, OBSERVABILITY_FILES.publicWebProbeEnv, errors, checked);
  const service = readText(root, OBSERVABILITY_FILES.publicWebProbeService, errors, checked);
  const timer = readText(root, OBSERVABILITY_FILES.publicWebProbeTimer, errors, checked);

  for (const token of [
    "--proto '=https'",
    '--tlsv1.2',
    '--connect-timeout "$PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS"',
    '--max-time "$PUBLIC_WEB_PROBE_MAX_TIME_SECONDS"',
    '--max-filesize "$PUBLIC_WEB_PROBE_MAX_BYTES"',
    '--max-redirs 0',
    '--resolve "$validated_host:443:$validated_ip"',
    'lunchlineup_public_web_probe_success',
    'lunchlineup_public_web_probe_last_attempt_timestamp_seconds',
    'X-LunchLineUp-Release',
    '<h1>LunchLineup</h1>',
    '/_next/static/',
    'mv "$metrics_tmp" "$PUBLIC_WEB_PROBE_METRICS_FILE"',
  ]) {
    expect(errors, script.includes(token), `${OBSERVABILITY_FILES.publicWebProbe}: missing ${token}`);
  }
  expect(errors, script.includes('parsed.scheme != "https"'), `${OBSERVABILITY_FILES.publicWebProbe}: URL validation must require HTTPS`);
  expect(errors, script.includes('parsed.path not in ("", "/")'), `${OBSERVABILITY_FILES.publicWebProbe}: URL validation must require the root path`);
  expect(errors, script.includes('parsed.username or parsed.password or parsed.query or parsed.fragment'), `${OBSERVABILITY_FILES.publicWebProbe}: URL validation must reject credentials, queries, and fragments`);
  expect(errors, script.includes('socket.getaddrinfo(host, 443'), `${OBSERVABILITY_FILES.publicWebProbe}: URL validation must resolve the public hostname`);
  expect(errors, script.includes('any(not address.is_global for address in addresses)'), `${OBSERVABILITY_FILES.publicWebProbe}: URL validation must reject private DNS answers`);

  for (const token of [
    'PUBLIC_WEB_PROBE_URL=https://lunchlineup.com/',
    'PUBLIC_WEB_PROBE_METRICS_FILE=/var/lib/node_exporter/textfile_collector/lunchlineup_public_web.prom',
    'PUBLIC_WEB_PROBE_EXPECTED_RELEASE_FILE=/opt/lunchlineup/current/DEPLOYED_GIT_SHA',
    'PUBLIC_WEB_PROBE_CONNECT_TIMEOUT_SECONDS=5',
    'PUBLIC_WEB_PROBE_MAX_TIME_SECONDS=15',
    'PUBLIC_WEB_PROBE_MAX_BYTES=262144',
  ]) {
    expect(errors, environment.includes(token), `${OBSERVABILITY_FILES.publicWebProbeEnv}: missing ${token}`);
  }

  for (const token of [
    'User=lunchlineup',
    'EnvironmentFile=/etc/lunchlineup/public-web-probe.env',
    'ExecStart=/usr/bin/bash /opt/lunchlineup/current/infrastructure/control/public-web-probe.sh',
    'TimeoutStartSec=25s',
    'NoNewPrivileges=true',
    'ProtectSystem=strict',
    'ReadWritePaths=/var/lib/node_exporter/textfile_collector',
    'RestrictAddressFamilies=AF_INET AF_INET6',
  ]) {
    expect(errors, service.includes(token), `${OBSERVABILITY_FILES.publicWebProbeService}: missing ${token}`);
  }

  for (const token of [
    'OnBootSec=30s',
    'OnUnitActiveSec=60s',
    'Persistent=true',
    'Unit=lunchlineup-public-web-probe.service',
  ]) {
    expect(errors, timer.includes(token), `${OBSERVABILITY_FILES.publicWebProbeTimer}: missing ${token}`);
  }
}


function validateComposeEstateShape(compose, errors) {
  const services = asMap(compose?.services);
  const volumes = asMap(compose?.volumes);
  const networks = asMap(compose?.networks);
  const secrets = asMap(compose?.secrets);

  for (const name of REMOVED_SERVICES) {
    expect(errors, !Object.hasOwn(services, name), `docker-compose.yml: ${name} is an estate system and must not be a Compose service`);
  }
  for (const name of REMOVED_VOLUMES) {
    expect(errors, !Object.hasOwn(volumes, name), `docker-compose.yml: volume ${name} belongs to a removed component`);
  }
  for (const name of REMOVED_NETWORKS) {
    expect(errors, !Object.hasOwn(networks, name), `docker-compose.yml: network ${name} belongs to a removed component`);
  }
  for (const name of REMOVED_SECRETS) {
    expect(errors, !Object.hasOwn(secrets, name), `docker-compose.yml: secret ${name} belongs to a removed component`);
  }
  expect(errors, String(secrets.metrics_token?.file ?? '').includes('${METRICS_TOKEN_FILE:-'), 'docker-compose.yml: metrics_token secret must come from METRICS_TOKEN_FILE');

  for (const [name, service] of Object.entries(services)) {
    const rendered = JSON.stringify(service);
    expect(errors, !/OTEL_EXPORTER|otel-collector|tempo|promtail|PITR_|BACKUP_|archive-wal/.test(rendered), `docker-compose.yml: ${name} must not reference removed tracing, backup or PITR wiring`);
    expect(errors, !listValue(service.networks).some((network) => REMOVED_NETWORKS.includes(network)), `docker-compose.yml: ${name} must not join a removed network`);
  }

  const proxy = services.proxy;
  expect(errors, proxy, 'docker-compose.yml: missing proxy service');
  if (proxy) {
    const environment = environmentMap(proxy.environment);
    expect(errors, hasVolume(proxy, './infrastructure/caddy/Caddyfile', '/etc/caddy/Caddyfile'), 'docker-compose.yml: proxy must mount the checked-in Caddyfile');
    expect(errors, environment.CADDY_SITE_ADDRESSES?.includes('${CADDY_SITE_ADDRESSES:-'), 'docker-compose.yml: proxy must pass CADDY_SITE_ADDRESSES with a default');
    expect(errors, environment.ADMIN_EMAIL?.includes('${ADMIN_EMAIL:-'), 'docker-compose.yml: proxy must pass ADMIN_EMAIL with a default');
    for (const network of ['external', 'app', 'management']) {
      expect(errors, listValue(proxy.networks).includes(network), `docker-compose.yml: proxy must attach to the ${network} network`);
    }
    expect(errors, hasSecret(proxy, 'metrics_token'), 'docker-compose.yml: proxy must receive metrics_token for the estate metrics gateway');
    expect(errors, asArray(proxy.ports).every((port) => !String(port).includes(String(METRICS_GATEWAY_PORT))), 'docker-compose.yml: the base proxy must not publish the metrics gateway; only the private/production overlays do');
  }

  const postgres = services.postgres;
  expect(errors, postgres, 'docker-compose.yml: missing postgres service');
  if (postgres) {
    const command = commandList(postgres.command);
    expect(errors, command.includes('archive_mode=${POSTGRES_ARCHIVE_MODE:-off}'), 'docker-compose.yml: postgres archive_mode must default to off and be set by POSTGRES_ARCHIVE_MODE');
    expect(errors, command.includes('archive_command=${POSTGRES_ARCHIVE_COMMAND:-/bin/false}'), 'docker-compose.yml: postgres archive_command must default to fail-closed /bin/false and be set by POSTGRES_ARCHIVE_COMMAND');
    expect(errors, listValue(postgres.networks).join(',') === 'data', 'docker-compose.yml: postgres must stay on the internal data network only');
  }
}

function validateMetricsGateway(root, relativePath, errors, checked) {
  const content = readText(root, relativePath, errors, checked);
  expect(errors, content.includes(`http://:${METRICS_GATEWAY_PORT} {`), `${relativePath}: missing the :${METRICS_GATEWAY_PORT} estate metrics gateway site`);
  expect(errors, content.includes('@authorized header Authorization "Bearer {file./run/secrets/metrics_token}"'), `${relativePath}: the metrics gateway must require the metrics_token bearer`);
  expect(errors, content.includes('respond "unauthorized" 401'), `${relativePath}: the metrics gateway must answer 401 without the token`);
  expect(errors, content.includes('respond "not found" 404'), `${relativePath}: the metrics gateway must answer 404 for unknown paths`);
  const escape = (value) => value.replace(/[.*+?^${}()|[\]\\\/-]/g, '\\$&');
  for (const [service, { upstream, path, upstreamHost }] of Object.entries(METRICS_GATEWAY_SERVICES)) {
    const proxyBody = upstreamHost
      ? '\\s+\\{(?:\\s+#[^\\n]*)*\\s+header_up Host \\{upstream_hostport\\}\\s+\\}'
      : '';
    const block = new RegExp(`handle /metrics/${escape(service)} \\{\\s+rewrite \\* ${escape(path)}\\s+reverse_proxy ${escape(upstream)}${proxyBody}\\s+\\}`);
    expect(errors, block.test(content), `${relativePath}: /metrics/${service} must rewrite to ${path} and proxy to ${upstream}`);
  }
}

function validateEstateRules(root, errors, checked) {
  const rules = readYaml(root, OBSERVABILITY_FILES.estateRules, errors, checked);
  if (!rules) return;
  const groups = asArray(rules.groups);
  expect(errors, groups.length > 0, `${OBSERVABILITY_FILES.estateRules}: must define rule groups`);
  const names = new Set();
  for (const group of groups) {
    for (const rule of asArray(group?.rules)) {
      if (rule?.alert) {
        names.add(rule.alert);
        expect(errors, !forbiddenAlertPattern.test(rule.alert), `${OBSERVABILITY_FILES.estateRules}: ${rule.alert} belongs to the estate backup system and must not be defined here`);
        expect(errors, hasDuration(rule.for), `${OBSERVABILITY_FILES.estateRules}: ${rule.alert} needs a valid for: duration`);
      }
      const expr = String(rule?.expr ?? '');
      expect(errors, !/job=~?"(?:api|api-v2|worker|engine|webhook-replay|control)"/.test(expr), `${OBSERVABILITY_FILES.estateRules}: ${rule?.alert} must select job="lunchlineup" with a service label, not a per-service job`);
    }
  }
  for (const alert of expectedAlerts) {
    expect(errors, names.has(alert), `${OBSERVABILITY_FILES.estateRules}: missing alert ${alert}`);
  }
  const serviceDown = groups.flatMap((group) => asArray(group?.rules)).find((rule) => rule?.alert === 'ServiceDown');
  expect(errors, String(serviceDown?.expr ?? '').includes('up{job="lunchlineup"} == 0'), `${OBSERVABILITY_FILES.estateRules}: ServiceDown must cover job="lunchlineup"`);
  const text = readText(root, OBSERVABILITY_FILES.estateRules, errors, checked);
  expect(errors, !/lunchlineup_(?:pitr|backup)_/.test(text), `${OBSERVABILITY_FILES.estateRules}: no in-stack backup or PITR telemetry rules`);

  for (const key of ['estateRuleTestMain', 'estateRuleTestNative', 'estateRuleTestDeletion']) {
    const fixture = readYaml(root, OBSERVABILITY_FILES[key], errors, checked);
    expect(errors, asArray(fixture?.tests).length > 0 && JSON.stringify(fixture?.rule_files) === '["../lunchlineup-rules.yml"]', `${OBSERVABILITY_FILES[key]}: fixtures must load docs/estate/lunchlineup-rules.yml`);
  }
}

function validateEstateTargets(root, errors, checked) {
  const targets = readYaml(root, OBSERVABILITY_FILES.estateTargets, errors, checked);
  if (!targets) return;
  const jobs = asArray(targets.scrape_configs);
  expect(errors, jobs.length === 1 && jobs[0]?.job_name === 'lunchlineup', `${OBSERVABILITY_FILES.estateTargets}: must define exactly one scrape job named lunchlineup`);
  const job = jobs[0] ?? {};
  expect(errors, job.authorization?.type === 'Bearer' && typeof job.authorization?.credentials_file === 'string', `${OBSERVABILITY_FILES.estateTargets}: must scrape with a Bearer credentials_file`);
  expect(errors, job.scheme === undefined || job.scheme === 'http', `${OBSERVABILITY_FILES.estateTargets}: the gateway speaks plain HTTP on the private network`);
  const seen = new Map();
  for (const config of asArray(job.static_configs)) {
    expect(errors, JSON.stringify(config.targets) === JSON.stringify([`10.1.50.10:${METRICS_GATEWAY_PORT}`]), `${OBSERVABILITY_FILES.estateTargets}: every target must be the VM107 gateway 10.1.50.10:${METRICS_GATEWAY_PORT}`);
    seen.set(config.labels?.service, config.labels?.__metrics_path__);
  }
  for (const service of Object.keys(METRICS_GATEWAY_SERVICES)) {
    expect(errors, seen.get(service) === `/metrics/${service}`, `${OBSERVABILITY_FILES.estateTargets}: ${service} must use __metrics_path__ /metrics/${service}`);
  }
  expect(errors, seen.size === Object.keys(METRICS_GATEWAY_SERVICES).length, `${OBSERVABILITY_FILES.estateTargets}: unexpected extra scrape services`);
}

function validateEstateDashboards(root, errors, checked) {
  for (const key of ['platformDashboard', 'deletionDashboard']) {
    const text = readText(root, OBSERVABILITY_FILES[key], errors, checked);
    let dashboard;
    try {
      dashboard = JSON.parse(text);
    } catch (error) {
      addError(errors, `${OBSERVABILITY_FILES[key]}: invalid JSON: ${error.message}`);
      continue;
    }
    expect(errors, asArray(dashboard.panels).length > 0, `${OBSERVABILITY_FILES[key]}: must define panels`);
    expect(errors, !/lunchlineup_(?:pitr|backup)_/.test(text), `${OBSERVABILITY_FILES[key]}: no in-stack backup or PITR panels`);
    expect(errors, !/job=\\"(?:api|api-v2|worker|engine|webhook-replay|control)\\"/.test(text), `${OBSERVABILITY_FILES[key]}: queries must select job="lunchlineup" with a service label`);
  }
}

function validateNativeCompose(compose, errors) {
  const services = asMap(compose?.services), api = services['api-v2'];
  expect(errors, api, 'docker-compose.yml: missing api-v2 service');
  if (!api) return;
  expect(errors, api.stop_grace_period === '30s', 'docker-compose.yml: api-v2 must retain the reviewed 30s stop grace for its 15s application drain deadline');
  const environment = environmentMap(api.environment);
  expect(errors, environment.METRICS_TOKEN_FILE === '/run/secrets/metrics_token', 'docker-compose.yml: api-v2 must read the mounted metrics token file');
  expect(errors, !Object.hasOwn(environment, 'METRICS_TOKEN'), 'docker-compose.yml: api-v2 must not configure an inline or conflicting METRICS_TOKEN');
  if (Array.isArray(api.environment)) {
    expect(errors, api.environment.filter(value => String(value).split('=')[0] === 'METRICS_TOKEN_FILE').length === 1, 'docker-compose.yml: api-v2 must have one metrics token file binding');
  }
  expect(errors, api.env_file === undefined, 'docker-compose.yml: api-v2 must not add unreviewed env_file token sources');
  const mounts = asArray(api.secrets).filter(secret => secret === 'metrics_token' || (isObject(secret) && secret.source === 'metrics_token' && (secret.target === undefined || secret.target === 'metrics_token')));
  expect(errors, mounts.length === 1, 'docker-compose.yml: api-v2 must mount metrics_token once at its standard secret target');
  expect(errors, api.ports === undefined || (Array.isArray(api.ports) && api.ports.length === 0), 'docker-compose.yml: api-v2 must not publish metrics or application ports');
  expect(errors, api.network_mode === undefined, 'docker-compose.yml: api-v2 must use scoped Compose networks');
  const networks = listValue(api.networks);
  expect(errors, networks.includes('app') && listValue(services.proxy?.networks).includes('app'), 'docker-compose.yml: api-v2 and the proxy metrics gateway must share the app network');
  expect(errors, networks.every(name => ['app', 'data'].includes(name)), 'docker-compose.yml: api-v2 must keep its existing internal networks');
  expect(errors, api.read_only === true && api.privileged !== true && listValue(api.cap_drop).includes('ALL') && asArray(api.cap_add).length === 0, 'docker-compose.yml: api-v2 must retain locked runtime privileges');
  expect(errors, listValue(api.security_opt).includes('no-new-privileges:true'), 'docker-compose.yml: api-v2 must retain no-new-privileges');
  const shadowTargets = new Set(['/', '/run', '/run/secrets', '/run/secrets/metrics_token']);
  expect(errors, !asArray(api.volumes).some(volume => shadowTargets.has(parseVolume(volume).target)), 'docker-compose.yml: api-v2 volumes must not shadow the metrics secret');
}
export function validateObservabilityConfigs(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const errors = [];
  const checked = new Set();

  const compose = readYaml(root, OBSERVABILITY_FILES.compose, errors, checked);

  validateCaddyfile(root, OBSERVABILITY_FILES.caddy, errors, checked);
  validateCaddyfile(root, OBSERVABILITY_FILES.caddyTemplate, errors, checked);
  validateMetricsGateway(root, OBSERVABILITY_FILES.caddyPilot, errors, checked);
  validateMetricsGateway(root, OBSERVABILITY_FILES.caddyProduction, errors, checked);
  validateWebContentSecurityPolicy(root, errors, checked);
  validatePublicWebProbe(root, errors, checked);
  validateEstateRules(root, errors, checked);
  validateEstateTargets(root, errors, checked);
  validateEstateDashboards(root, errors, checked);

  if (compose) {
    validateComposeEstateShape(compose, errors);
    validateNativeCompose(compose, errors);
  }

  return {
    ok: errors.length === 0,
    errors,
    checked: [...checked].sort(),
    root,
  };
}

function parseArgs(argv) {
  const parsed = {
    root: process.cwd(),
    help: false,
    toolMode: 'off',
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      parsed.help = true;
      continue;
    }
    if (arg === '--root') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--root requires a path');
      }
      parsed.root = argv[index];
      continue;
    }
    if (arg === '--tool-mode') {
      index += 1;
      if (!argv[index]) {
        throw new Error('--tool-mode requires off, auto, host, or container');
      }
      parsed.toolMode = argv[index];
      continue;
    }
    if (arg.startsWith('--tool-mode=')) {
      parsed.toolMode = arg.slice('--tool-mode='.length);
      continue;
    }
    if (arg.startsWith('-')) {
      throw new Error(`unknown option: ${arg}`);
    }
    parsed.root = arg;
  }

  if (!OBSERVABILITY_TOOL_MODES.includes(parsed.toolMode)) {
    throw new Error(`unknown --tool-mode: ${parsed.toolMode}`);
  }

  return parsed;
}

export function main(argv = process.argv.slice(2), streams = { stdout: process.stdout, stderr: process.stderr }) {
  let args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    streams.stderr.write(`${error.message}\n`);
    streams.stderr.write('Usage: node scripts/verify-observability-configs.mjs [--root <repo-root>] [--tool-mode off|auto|host|container]\n');
    return 2;
  }

  if (args.help) {
    streams.stdout.write('Usage: node scripts/verify-observability-configs.mjs [--root <repo-root>] [--tool-mode off|auto|host|container]\n');
    return 0;
  }

  const result = validateObservabilityConfigs({ root: args.root });
  if (!result.ok) {
    streams.stderr.write(`observability config validation failed for ${result.root}\n`);
    for (const error of result.errors) {
      streams.stderr.write(`- ${error}\n`);
    }
    return 1;
  }

  const toolResult = validateObservabilityTools({ root: args.root, mode: args.toolMode });
  if (!toolResult.ok) {
    streams.stderr.write(`observability tool validation failed for ${toolResult.root} (${toolResult.mode})\n`);
    for (const error of toolResult.errors) {
      streams.stderr.write(`- ${error}\n`);
    }
    for (const skipped of toolResult.skipped) {
      streams.stderr.write(`- ${skipped.id} fallback: ${skipped.fallbackCommand}\n`);
    }
    return 1;
  }

  streams.stdout.write(`observability config validation passed for ${result.root}\n`);
  for (const file of result.checked) {
    streams.stdout.write(`- ${file}\n`);
  }
  if (args.toolMode !== 'off') {
    streams.stdout.write(`observability tool validation completed in ${toolResult.mode} mode\n`);
    for (const check of toolResult.checks) {
      streams.stdout.write(`- ${check.id}: ${check.command}\n`);
    }
    for (const skipped of toolResult.skipped) {
      streams.stdout.write(`- ${skipped.id} skipped: ${skipped.reason}; fallback: ${skipped.fallbackCommand}\n`);
    }
  }
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = main();
}

