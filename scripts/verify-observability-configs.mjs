import yaml from 'js-yaml';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const OBSERVABILITY_FILES = Object.freeze({
  compose: 'docker-compose.yml',
  caddy: 'infrastructure/caddy/Caddyfile',
  caddyTemplate: 'infrastructure/caddy/Caddyfile.template',
  prometheus: 'infrastructure/prometheus/prometheus.yml',
  prometheusAlerts: 'infrastructure/prometheus/alerts/lunchlineup.yml',
  alertmanager: 'infrastructure/alertmanager/alertmanager.yml',
  publicWebProbe: 'infrastructure/control/public-web-probe.sh',
  publicWebProbeEnv: 'infrastructure/systemd/lunchlineup-public-web-probe.env.example',
  publicWebProbeService: 'infrastructure/systemd/lunchlineup-public-web-probe.service',
  publicWebProbeTimer: 'infrastructure/systemd/lunchlineup-public-web-probe.timer',
});

export const OBSERVABILITY_TOOL_IMAGES = Object.freeze({
  caddy: 'caddy:2-alpine@sha256:5f5c8640aae01df9654968d946d8f1a56c497f1dd5c5cda4cf95ab7c14d58648',
  prometheus: 'prom/prometheus:v2.51.2@sha256:4f6c47e39a9064028766e8c95890ed15690c30f00c4ba14e7ce6ae1ded0295b1',
  alertmanager: 'prom/alertmanager:v0.27.0@sha256:e13b6ed5cb929eeaee733479dce55e10eb3bc2e9c4586c705a4e8da41e5eacf5',
});

export const OBSERVABILITY_TOOL_MODES = Object.freeze(['off', 'auto', 'host', 'container']);
export const PROMETHEUS_VALIDATION_CREDENTIALS_FILE =
  'infrastructure/prometheus/promtool-validation-credentials.txt';
export const PROMETHEUS_RULE_TEST_FILES = Object.freeze([
  'infrastructure/prometheus/alerts/tests/lunchlineup.test.yml',
  'infrastructure/prometheus/alerts/tests/tenant-deletion-billing.test.yml',
]);

const scriptDir = dirname(fileURLToPath(import.meta.url));
const defaultRoot = resolve(scriptDir, '..');
const digestPinnedImageRefPattern = /^[^\s]+:[^:@\s]+@sha256:[a-f0-9]{64}$/i;
const durationPattern = /^(?:0|[1-9][0-9]*)(?:ms|s|m|h|d|w|y)$/;
const containerPaths = Object.freeze({
  caddyConfig: '/etc/caddy/Caddyfile',
  prometheusConfig: '/etc/prometheus/prometheus.yml',
  prometheusAlertsDir: '/etc/prometheus/alerts',
  prometheusAlertRules: '/etc/prometheus/alerts/lunchlineup.yml',
  prometheusCredentials: '/run/secrets/metrics_token',
  prometheusRuleTestsDir: '/etc/prometheus/alerts/tests',
  alertmanagerConfig: '/etc/alertmanager/alertmanager.yml',
});
const toolVersionArgs = Object.freeze({
  caddy: ['version'],
  promtool: ['--version'],
  amtool: ['--version'],
});
const expectedScrapeJobs = Object.freeze({
  prometheus: {
    targets: ['localhost:9090'],
  },
  api: {
    targets: ['api:3000'],
    metricsPath: '/metrics',
    interval: '10s',
    bearerTokenFile: '/run/secrets/metrics_token',
  },
  engine: {
    targets: ['engine:8000'],
    metricsPath: '/metrics',
    interval: '10s',
  },
  worker: {
    targets: ['worker:3003'],
    metricsPath: '/metrics',
    interval: '15s',
  },
  'webhook-replay': {
    targets: ['webhook-replay:3004'],
    metricsPath: '/metrics',
    interval: '15s',
  },
  control: {
    targets: ['control:3001'],
    metricsPath: '/api/metrics',
    interval: '30s',
    bearerTokenFile: '/run/secrets/metrics_token',
  },
  node: {
    targets: ['node-exporter:9100'],
    interval: '30s',
  },
});
const expectedAlerts = Object.freeze([
  'ServiceDown',
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
  'BackupMissingTelemetry',
  'BackupStale',
  'PitrBaseBackupTelemetryMissing',
  'PitrBaseBackupStale',
  'PitrWalArchiveFailure',
  'PitrWalArchiveStale',
  'RetentionPurgeTelemetryMissing',
  'RetentionPurgeStale',
  'ApplicationDataRetentionExecutionTelemetryMissing',
  'ApplicationDataRetentionExecutionStale',
  'RetentionPurgeFailed',
  'RetentionPurgeCandidatesReady',
]);

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

function commandSpec(command, args) {
  return {
    command,
    args: args.map((arg) => String(arg)),
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

function resultOutput(result) {
  return [result.stderr, result.stdout]
    .filter((value) => value.trim().length > 0)
    .join('\n')
    .trim()
    .split(/\r?\n/)
    .slice(0, 8)
    .join(' | ');
}

function missingExecutable(result) {
  return result.error?.code === 'ENOENT';
}

function runToolCommand(command, root, runner) {
  return normalizeToolResult(runner(command.command, command.args, { cwd: root }));
}

function toolAvailable(tool, root, runner) {
  const command = commandSpec(tool, toolVersionArgs[tool] ?? ['--version']);
  const result = runToolCommand(command, root, runner);
  return !missingExecutable(result) && result.status === 0;
}

function repoPrometheusRulePath(root, runtimeRuleFile) {
  if (runtimeRuleFile === '/etc/prometheus/alerts/*.yml') {
    return join(root, 'infrastructure/prometheus/alerts', '*.yml').replaceAll('\\', '/');
  }
  if (runtimeRuleFile.startsWith('/etc/prometheus/alerts/')) {
    return join(root, 'infrastructure/prometheus/alerts', runtimeRuleFile.slice('/etc/prometheus/alerts/'.length)).replaceAll('\\', '/');
  }
  return runtimeRuleFile;
}

function prepareHostPrometheusConfigCommand(root) {
  const errors = [];
  const checked = new Set();
  const prometheus = readYaml(root, OBSERVABILITY_FILES.prometheus, errors, checked);
  if (!prometheus || errors.length > 0) {
    throw new Error(`cannot prepare promtool host config: ${errors.join('; ')}`);
  }

  const tempDir = mkdtempSync(join(tmpdir(), 'lunchlineup-promtool-'));
  const tempConfigPath = join(tempDir, 'prometheus.yml');
  const adjustedConfig = {
    ...prometheus,
    rule_files: asArray(prometheus.rule_files).map((ruleFile) => repoPrometheusRulePath(root, String(ruleFile))),
    scrape_configs: asArray(prometheus.scrape_configs).map((scrapeConfig) => {
      const authorization = asMap(scrapeConfig?.authorization);
      if (authorization.credentials_file !== containerPaths.prometheusCredentials) {
        return scrapeConfig;
      }
      return {
        ...scrapeConfig,
        authorization: {
          ...authorization,
          credentials_file: join(root, PROMETHEUS_VALIDATION_CREDENTIALS_FILE),
        },
      };
    }),
  };
  writeFileSync(tempConfigPath, yaml.dump(adjustedConfig, { lineWidth: -1 }), 'utf8');

  return {
    command: commandSpec('promtool', ['check', 'config', tempConfigPath]),
    cleanup: () => rmSync(tempDir, { recursive: true, force: true }),
  };
}

function prepareHostToolCommand(root, check) {
  if (check.id === 'prometheus-config') {
    return prepareHostPrometheusConfigCommand(root);
  }

  return {
    command: check.hostCommand,
    cleanup: () => {},
  };
}

function commandFailure(check, command, result) {
  const output = resultOutput(result);
  const suffix = output ? `: ${output}` : '';
  if (missingExecutable(result)) {
    return `${check.id}: ${command.command} was not found on PATH`;
  }
  return `${check.id}: ${formatCommand(command)} exited ${result.status}${suffix}`;
}

export function buildObservabilityToolCommands(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const caddyChecks = [
    [OBSERVABILITY_FILES.caddy, 'active Caddyfile'],
    [OBSERVABILITY_FILES.caddyTemplate, 'template Caddyfile'],
  ].map(([relativePath, label]) => ({
    id: `caddy-${relativePath.endsWith('.template') ? 'template' : 'config'}`,
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
      id: 'prometheus-config',
      tool: 'promtool',
      label: 'Prometheus config and referenced rules',
      hostCommand: commandSpec('promtool', ['check', 'config', join(root, OBSERVABILITY_FILES.prometheus)]),
      containerCommand: commandSpec('docker', [
        'run',
        '--rm',
        '-v',
        dockerVolume(root, OBSERVABILITY_FILES.prometheus, containerPaths.prometheusConfig),
        '-v',
        dockerVolume(root, 'infrastructure/prometheus/alerts', containerPaths.prometheusAlertsDir),
        '-v',
        dockerVolume(
          root,
          PROMETHEUS_VALIDATION_CREDENTIALS_FILE,
          containerPaths.prometheusCredentials,
        ),
        '--entrypoint',
        '/bin/promtool',
        OBSERVABILITY_TOOL_IMAGES.prometheus,
        'check',
        'config',
        containerPaths.prometheusConfig,
      ]),
    },
    {
      id: 'prometheus-rules',
      tool: 'promtool',
      label: 'Prometheus alert rules',
      hostCommand: commandSpec('promtool', ['check', 'rules', join(root, OBSERVABILITY_FILES.prometheusAlerts)]),
      containerCommand: commandSpec('docker', [
        'run',
        '--rm',
        '-v',
        dockerVolume(root, OBSERVABILITY_FILES.prometheusAlerts, containerPaths.prometheusAlertRules),
        '--entrypoint',
        '/bin/promtool',
        OBSERVABILITY_TOOL_IMAGES.prometheus,
        'check',
        'rules',
        containerPaths.prometheusAlertRules,
      ]),
    },
    {
      id: 'prometheus-rule-tests',
      tool: 'promtool',
      label: 'Prometheus alert rule fixtures',
      hostCommand: commandSpec('promtool', [
        'test',
        'rules',
        ...PROMETHEUS_RULE_TEST_FILES.map((relativePath) => join(root, relativePath)),
      ]),
      containerCommand: commandSpec('docker', [
        'run',
        '--rm',
        '-v',
        dockerVolume(root, 'infrastructure/prometheus/alerts', containerPaths.prometheusAlertsDir),
        '--workdir',
        containerPaths.prometheusRuleTestsDir,
        '--entrypoint',
        '/bin/promtool',
        OBSERVABILITY_TOOL_IMAGES.prometheus,
        'test',
        'rules',
        ...PROMETHEUS_RULE_TEST_FILES.map((relativePath) => basename(relativePath)),
      ]),
    },
    {
      id: 'alertmanager-config',
      tool: 'amtool',
      label: 'Alertmanager config',
      hostCommand: commandSpec('amtool', ['check-config', join(root, OBSERVABILITY_FILES.alertmanager)]),
      containerCommand: commandSpec('docker', [
        'run',
        '--rm',
        '-v',
        dockerVolume(root, OBSERVABILITY_FILES.alertmanager, containerPaths.alertmanagerConfig),
        '--entrypoint',
        '/bin/amtool',
        OBSERVABILITY_TOOL_IMAGES.alertmanager,
        'check-config',
        containerPaths.alertmanagerConfig,
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

    let prepared;
    try {
      prepared = prepareHostToolCommand(root, check);
      const result = runToolCommand(prepared.command, root, runner);
      checks.push({
        id: check.id,
        label: check.label,
        mode: 'host',
        command: check.id === 'prometheus-config'
          ? `${formatCommand(check.hostCommand)} (using a temporary repo-local rule_files path)`
          : formatCommand(prepared.command),
        status: result.status,
      });
      if (result.status !== 0) {
        errors.push(commandFailure(check, prepared.command, result));
      }
    } catch (error) {
      errors.push(`${check.id}: ${error.message}`);
    } finally {
      prepared?.cleanup();
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

function staticTargets(staticConfigs) {
  return asArray(staticConfigs).flatMap((config) => asArray(config?.targets).map(String));
}

function jobTargets(job) {
  return staticTargets(job?.static_configs);
}

function alertmanagerTargets(alerting) {
  return asArray(alerting?.alertmanagers).flatMap((manager) => staticTargets(manager?.static_configs));
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
    validateSecurityHeader(
      errors,
      relativePath,
      headerBlock,
      'Content-Security-Policy',
      (value) => (
        value.includes("default-src 'self'")
        && value.includes("object-src 'none'")
        && value.includes("frame-ancestors 'none'")
        && value.includes('https://challenges.cloudflare.com')
        && value.includes('upgrade-insecure-requests')
      ),
      'include the required CSP directives',
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

function validateComposeObservability(compose, errors) {
  const services = asMap(compose?.services);
  const secrets = asMap(compose?.secrets);

  for (const serviceName of ['proxy', 'prometheus', 'alertmanager', 'node-exporter']) {
    const service = services[serviceName];
    expect(errors, service, `docker-compose.yml: missing ${serviceName} service`);
    if (!service) {
      continue;
    }
    expect(
      errors,
      digestPinnedImageRefPattern.test(String(service.image ?? '')),
      `docker-compose.yml: ${serviceName} image must be tag and digest pinned`,
    );
  }

  const proxy = services.proxy;
  if (proxy) {
    const environment = environmentMap(proxy.environment);
    expect(errors, hasVolume(proxy, './infrastructure/caddy/Caddyfile', '/etc/caddy/Caddyfile'), 'docker-compose.yml: proxy must mount the checked-in Caddyfile');
    expect(errors, environment.CADDY_SITE_ADDRESSES?.includes('${CADDY_SITE_ADDRESSES:-'), 'docker-compose.yml: proxy must pass CADDY_SITE_ADDRESSES with a default');
    expect(errors, environment.ADMIN_EMAIL?.includes('${ADMIN_EMAIL:-'), 'docker-compose.yml: proxy must pass ADMIN_EMAIL with a default');
    expect(errors, listValue(proxy.networks).includes('external'), 'docker-compose.yml: proxy must attach to the external network');
    expect(errors, listValue(proxy.networks).includes('app'), 'docker-compose.yml: proxy must attach to the app network');
  }

  const prometheus = services.prometheus;
  if (prometheus) {
    expect(errors, hasVolume(prometheus, './infrastructure/prometheus/prometheus.yml', '/etc/prometheus/prometheus.yml', 'ro'), 'docker-compose.yml: prometheus must mount prometheus.yml read-only');
    expect(errors, hasVolume(prometheus, './infrastructure/prometheus/alerts', '/etc/prometheus/alerts', 'ro'), 'docker-compose.yml: prometheus must mount alert rules read-only');
    expect(errors, hasSecret(prometheus, 'metrics_token'), 'docker-compose.yml: prometheus must receive metrics_token secret');
    expect(errors, commandList(prometheus.command).includes('--config.file=/etc/prometheus/prometheus.yml'), 'docker-compose.yml: prometheus must load the mounted config file');
    expect(errors, listValue(prometheus.networks).includes('management'), 'docker-compose.yml: prometheus must attach to management network');
    expect(errors, listValue(prometheus.networks).includes('app'), 'docker-compose.yml: prometheus must attach to app network');
  }

  const alertmanager = services.alertmanager;
  if (alertmanager) {
    const publishedPorts = asArray(alertmanager.ports).map(String);
    expect(errors, hasVolume(alertmanager, './infrastructure/alertmanager/alertmanager.yml', '/etc/alertmanager/alertmanager.yml', 'ro'), 'docker-compose.yml: alertmanager must mount alertmanager.yml read-only');
    expect(errors, hasSecret(alertmanager, 'alertmanager_webhook_url'), 'docker-compose.yml: alertmanager must receive alertmanager_webhook_url secret');
    expect(errors, commandList(alertmanager.command).includes('--config.file=/etc/alertmanager/alertmanager.yml'), 'docker-compose.yml: alertmanager must load the mounted config file');
    expect(errors, listValue(alertmanager.networks).includes('management'), 'docker-compose.yml: alertmanager must stay on the management network');
    expect(
      errors,
      publishedPorts.length === 1 && publishedPorts[0] === '127.0.0.1:9093:9093',
      'docker-compose.yml: alertmanager must publish only exact 127.0.0.1:9093:9093',
    );
  }

  const nodeExporter = services['node-exporter'];
  if (nodeExporter) {
    expect(errors, commandList(nodeExporter.command).includes('--collector.textfile.directory=/textfile_collector'), 'docker-compose.yml: node-exporter must expose the textfile collector');
    expect(errors, listValue(nodeExporter.networks).includes('management'), 'docker-compose.yml: node-exporter must stay on the management network');
  }

  expect(errors, String(secrets.metrics_token?.file ?? '').includes('${METRICS_TOKEN_FILE:-'), 'docker-compose.yml: metrics_token secret must come from METRICS_TOKEN_FILE');
  expect(errors, String(secrets.alertmanager_webhook_url?.file ?? '').includes('${ALERTMANAGER_WEBHOOK_URL_FILE:-'), 'docker-compose.yml: alertmanager_webhook_url secret must come from ALERTMANAGER_WEBHOOK_URL_FILE');
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

function validatePrometheusConfig(root, prometheus, compose, errors) {
  const services = asMap(compose?.services);
  const globalConfig = asMap(prometheus?.global);

  expect(errors, hasDuration(globalConfig.scrape_interval), 'prometheus.yml: global.scrape_interval must be a Prometheus duration');
  expect(errors, hasDuration(globalConfig.evaluation_interval), 'prometheus.yml: global.evaluation_interval must be a Prometheus duration');
  expect(errors, globalConfig.external_labels?.cluster === 'lunchlineup', 'prometheus.yml: cluster external label must be lunchlineup');
  expect(errors, globalConfig.external_labels?.environment === 'lunchlineup-compose', 'prometheus.yml: environment external label must be lunchlineup-compose');
  expect(errors, asArray(prometheus?.rule_files).includes('/etc/prometheus/alerts/*.yml'), 'prometheus.yml: rule_files must load /etc/prometheus/alerts/*.yml');
  expect(errors, alertmanagerTargets(prometheus?.alerting).includes('alertmanager:9093'), 'prometheus.yml: alerting must target alertmanager:9093');

  const jobs = asArray(prometheus?.scrape_configs);
  const jobsByName = new Map(jobs.map((job) => [job.job_name, job]));
  expect(errors, jobs.length === jobsByName.size, 'prometheus.yml: scrape job names must be unique');

  for (const [jobName, contract] of Object.entries(expectedScrapeJobs)) {
    const job = jobsByName.get(jobName);
    expect(errors, job, `prometheus.yml: missing ${jobName} scrape job`);
    if (!job) {
      continue;
    }

    expect(errors, JSON.stringify(jobTargets(job)) === JSON.stringify(contract.targets), `prometheus.yml: ${jobName} scrape targets must be ${contract.targets.join(', ')}`);
    if (contract.metricsPath) {
      expect(errors, job.metrics_path === contract.metricsPath, `prometheus.yml: ${jobName} metrics_path must be ${contract.metricsPath}`);
    }
    if (contract.interval) {
      expect(errors, job.scrape_interval === contract.interval, `prometheus.yml: ${jobName} scrape_interval must be ${contract.interval}`);
    }
    if (contract.bearerTokenFile) {
      expect(errors, job.authorization?.type === 'Bearer', `prometheus.yml: ${jobName} scrape must use Bearer authorization`);
      expect(errors, job.authorization?.credentials_file === contract.bearerTokenFile, `prometheus.yml: ${jobName} scrape must read ${contract.bearerTokenFile}`);
    }
  }

  for (const job of jobs) {
    for (const target of jobTargets(job)) {
      const serviceName = target.split(':')[0];
      if (serviceName === 'localhost') {
        continue;
      }
      expect(errors, services[serviceName], `prometheus.yml: target ${target} must resolve to a Compose service`);
      expect(errors, !serviceName.startsWith('lunchlineup-'), `prometheus.yml: target ${target} must use Compose service DNS, not a fixed container name`);
    }
  }

  for (const ruleFile of asArray(prometheus?.rule_files)) {
    if (ruleFile.startsWith('/etc/prometheus/alerts/')) {
      const relative = ruleFile.replace('/etc/prometheus/alerts/', 'infrastructure/prometheus/alerts/');
      if (!relative.includes('*')) {
        expect(errors, existsSync(join(root, relative)), `prometheus.yml: rule file ${ruleFile} must exist in the repo`);
      }
    }
  }
}

function validateBalancedExpression(expression) {
  const stack = [];
  const pairs = new Map([
    [')', '('],
    [']', '['],
    ['}', '{'],
  ]);
  let quoted = false;
  let escaped = false;

  for (const char of expression) {
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
    if (quoted) {
      continue;
    }
    if (char === '(' || char === '[' || char === '{') {
      stack.push(char);
      continue;
    }
    if (pairs.has(char) && stack.pop() !== pairs.get(char)) {
      return false;
    }
  }

  return !quoted && stack.length === 0;
}

function extractJobLabelValues(expression) {
  const values = [];
  for (const match of expression.matchAll(/\bjob\s*(=|=~)\s*"([^"]+)"/g)) {
    if (match[1] === '=~') {
      values.push(...match[2].split('|').filter(Boolean));
    } else {
      values.push(match[2]);
    }
  }
  return unique(values);
}

function validateAlertRules(root, alertRules, prometheus, errors) {
  const configuredJobs = new Set(asArray(prometheus?.scrape_configs).map((job) => job.job_name).filter(Boolean));
  const groups = asArray(alertRules?.groups);
  const groupNames = groups.map((group) => group.name).filter(Boolean);
  expect(errors, groups.length > 0, 'lunchlineup.yml: at least one alert group is required');
  expect(errors, groupNames.length === unique(groupNames).length, 'lunchlineup.yml: alert group names must be unique');

  const ruleEntries = [];
  for (const group of groups) {
    expect(errors, typeof group.name === 'string' && group.name.startsWith('lunchlineup.'), 'lunchlineup.yml: alert group names must use the lunchlineup namespace');
    expect(errors, hasDuration(group.interval), `lunchlineup.yml: group ${group.name ?? '<unnamed>'} must set a valid interval`);
    expect(errors, asArray(group.rules).length > 0, `lunchlineup.yml: group ${group.name ?? '<unnamed>'} must contain rules`);
    for (const rule of asArray(group.rules)) {
      ruleEntries.push({ groupName: group.name, rule });
    }
  }

  const alertNames = ruleEntries.map(({ rule }) => rule.alert).filter(Boolean);
  expect(errors, alertNames.length === unique(alertNames).length, 'lunchlineup.yml: alert names must be unique');
  for (const expectedAlert of expectedAlerts) {
    expect(errors, alertNames.includes(expectedAlert), `lunchlineup.yml: missing ${expectedAlert} alert`);
  }

  for (const { groupName, rule } of ruleEntries) {
    const alertName = rule.alert ?? '<unnamed>';
    expect(errors, typeof rule.alert === 'string' && rule.alert.length > 0, `lunchlineup.yml: group ${groupName} has an alert without a name`);
    expect(errors, typeof rule.expr === 'string' && rule.expr.trim().length > 0, `lunchlineup.yml: ${alertName} must set expr`);
    expect(errors, validateBalancedExpression(String(rule.expr ?? '')), `lunchlineup.yml: ${alertName} expr must have balanced PromQL delimiters`);
    expect(errors, hasDuration(rule.for), `lunchlineup.yml: ${alertName} must set a valid for duration`);
    expect(errors, ['critical', 'warning'].includes(rule.labels?.severity), `lunchlineup.yml: ${alertName} must set severity critical or warning`);
    expect(errors, typeof rule.labels?.team === 'string' && rule.labels.team.length > 0, `lunchlineup.yml: ${alertName} must set labels.team`);
    expect(errors, typeof rule.annotations?.summary === 'string' && rule.annotations.summary.length > 0, `lunchlineup.yml: ${alertName} must set annotations.summary`);
    expect(errors, typeof rule.annotations?.description === 'string' && rule.annotations.description.length > 0, `lunchlineup.yml: ${alertName} must set annotations.description`);

    const runbook = rule.annotations?.runbook;
    expect(errors, typeof runbook === 'string' && /^docs\/runbooks\/[^/]+\.md$/.test(runbook), `lunchlineup.yml: ${alertName} runbook must be a checked-in docs/runbooks markdown path`);
    if (typeof runbook === 'string') {
      expect(errors, existsSync(join(root, runbook)), `lunchlineup.yml: ${alertName} runbook ${runbook} must exist`);
    }

    for (const jobName of extractJobLabelValues(String(rule.expr ?? ''))) {
      expect(errors, configuredJobs.has(jobName), `lunchlineup.yml: ${alertName} references unknown Prometheus job ${jobName}`);
    }
  }

  const serviceDown = ruleEntries.find(({ rule }) => rule.alert === 'ServiceDown')?.rule;
  if (serviceDown) {
    const coveredJobs = extractJobLabelValues(serviceDown.expr);
    for (const expectedJob of ['api', 'engine', 'worker', 'webhook-replay', 'control', 'node']) {
      expect(errors, coveredJobs.includes(expectedJob), `lunchlineup.yml: ServiceDown must cover ${expectedJob}`);
    }
  }

  const publicWebUnavailable = ruleEntries.find(({ rule }) => rule.alert === 'PublicWebUnavailable')?.rule;
  if (publicWebUnavailable) {
    expect(errors, String(publicWebUnavailable.expr).includes('lunchlineup_public_web_probe_success{job="node"} == 0'), 'lunchlineup.yml: PublicWebUnavailable must page on a failed node textfile probe');
    expect(errors, publicWebUnavailable.labels?.severity === 'critical', 'lunchlineup.yml: PublicWebUnavailable must be critical');
  }

  const publicWebProbeStale = ruleEntries.find(({ rule }) => rule.alert === 'PublicWebProbeStale')?.rule;
  if (publicWebProbeStale) {
    const expression = String(publicWebProbeStale.expr);
    expect(errors, expression.includes('lunchlineup_public_web_probe_last_attempt_timestamp_seconds{job="node"}'), 'lunchlineup.yml: PublicWebProbeStale must use the last-attempt timestamp');
    expect(errors, expression.includes('absent('), 'lunchlineup.yml: PublicWebProbeStale must fail closed when telemetry is absent');
    expect(errors, publicWebProbeStale.labels?.severity === 'critical', 'lunchlineup.yml: PublicWebProbeStale must be critical');
  }

  for (const [alertName, metric] of [
    ['PasswordResetEmailDeadLetters', 'lunchlineup_password_reset_email_total'],
    ['StaffInvitationDeadLetters', 'lunchlineup_staff_invitation_outbox_total'],
    ['NotificationOutboxDeadLetters', 'lunchlineup_notification_outbox_total'],
  ]) {
    const alert = ruleEntries.find(({ rule }) => rule.alert === alertName)?.rule;
    if (!alert) continue;
    const expression = String(alert.expr);
    expect(errors, expression.includes(`increase(${metric}`), `lunchlineup.yml: ${alertName} must use recent terminal transitions`);
    expect(errors, expression.includes('status="dead_lettered"'), `lunchlineup.yml: ${alertName} must select dead-letter transitions`);
    expect(errors, expression.includes('[15m]'), `lunchlineup.yml: ${alertName} must recover after the bounded 15-minute incident window`);
  }

  const retentionExecutionMissing = ruleEntries.find(({ rule }) =>
    rule.alert === 'ApplicationDataRetentionExecutionTelemetryMissing')?.rule;
  if (retentionExecutionMissing) {
    const expression = String(retentionExecutionMissing.expr);
    expect(errors, expression.includes('absent('), 'lunchlineup.yml: application-data execution telemetry must fail closed when missing');
    expect(errors, expression.includes('mode="execute"'), 'lunchlineup.yml: application-data execution missing alert must require execute mode');
    expect(errors, expression.includes('stage="application_data"'), 'lunchlineup.yml: application-data execution missing alert must require the application_data stage');
  }

  const retentionExecutionStale = ruleEntries.find(({ rule }) =>
    rule.alert === 'ApplicationDataRetentionExecutionStale')?.rule;
  if (retentionExecutionStale) {
    const expression = String(retentionExecutionStale.expr);
    expect(errors, expression.includes('mode="execute"'), 'lunchlineup.yml: application-data execution stale alert must require execute mode');
    expect(errors, expression.includes('stage="application_data"'), 'lunchlineup.yml: application-data execution stale alert must require the application_data stage');
    expect(errors, expression.includes('> 93600'), 'lunchlineup.yml: application-data execution stale alert must use the 26-hour boundary');
  }
}

function validateAlertmanagerConfig(alertmanager, errors) {
  expect(errors, hasDuration(alertmanager?.global?.resolve_timeout), 'alertmanager.yml: global.resolve_timeout must be a duration');

  const route = alertmanager?.route;
  expect(errors, isObject(route), 'alertmanager.yml: route is required');
  if (route) {
    for (const label of ['alertname', 'service', 'severity']) {
      expect(errors, asArray(route.group_by).includes(label), `alertmanager.yml: route.group_by must include ${label}`);
    }
    expect(errors, hasDuration(route.group_wait), 'alertmanager.yml: route.group_wait must be a duration');
    expect(errors, hasDuration(route.group_interval), 'alertmanager.yml: route.group_interval must be a duration');
    expect(errors, hasDuration(route.repeat_interval), 'alertmanager.yml: route.repeat_interval must be a duration');
    expect(errors, route.receiver === 'production-paging-webhook', 'alertmanager.yml: root route must send to production-paging-webhook');

    const criticalRoute = asArray(route.routes).find((child) => asArray(child.matchers).includes('severity="critical"'));
    expect(errors, criticalRoute, 'alertmanager.yml: critical severity route is required');
    if (criticalRoute) {
      expect(errors, criticalRoute.receiver === 'production-paging-webhook', 'alertmanager.yml: critical route must page production-paging-webhook');
      expect(errors, hasDuration(criticalRoute.repeat_interval), 'alertmanager.yml: critical route repeat_interval must be a duration');
    }
  }

  const receivers = asArray(alertmanager?.receivers);
  const receiver = receivers.find((candidate) => candidate.name === 'production-paging-webhook');
  expect(errors, receiver, 'alertmanager.yml: production-paging-webhook receiver is required');
  if (receiver) {
    const webhookConfigs = asArray(receiver.webhook_configs);
    expect(errors, webhookConfigs.length > 0, 'alertmanager.yml: production-paging-webhook must define webhook_configs');
    for (const config of webhookConfigs) {
      expect(errors, config.url === undefined, 'alertmanager.yml: webhook URL must not be checked in as plaintext');
      expect(errors, config.url_file === '/run/secrets/alertmanager_webhook_url', 'alertmanager.yml: webhook must read /run/secrets/alertmanager_webhook_url');
      expect(errors, config.send_resolved === true, 'alertmanager.yml: webhook must send resolved notifications');
    }
  }
}

export function validateObservabilityConfigs(options = {}) {
  const root = resolve(options.root ?? defaultRoot);
  const errors = [];
  const checked = new Set();

  const compose = readYaml(root, OBSERVABILITY_FILES.compose, errors, checked);
  const prometheus = readYaml(root, OBSERVABILITY_FILES.prometheus, errors, checked);
  const alertRules = readYaml(root, OBSERVABILITY_FILES.prometheusAlerts, errors, checked);
  const alertmanager = readYaml(root, OBSERVABILITY_FILES.alertmanager, errors, checked);

  validateCaddyfile(root, OBSERVABILITY_FILES.caddy, errors, checked);
  validateCaddyfile(root, OBSERVABILITY_FILES.caddyTemplate, errors, checked);
  validatePublicWebProbe(root, errors, checked);

  if (compose) {
    validateComposeObservability(compose, errors);
  }
  if (prometheus && compose) {
    validatePrometheusConfig(root, prometheus, compose, errors);
  }
  if (alertRules && prometheus) {
    validateAlertRules(root, alertRules, prometheus, errors);
  }
  if (alertmanager) {
    validateAlertmanagerConfig(alertmanager, errors);
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
