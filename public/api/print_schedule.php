<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/print_schedule.php';

$printScheduleDebugMode = (function (): bool {
    $raw = $_REQUEST['debug'] ?? '';
    if (is_bool($raw)) {
        return $raw;
    }
    $value = strtolower(trim((string) $raw));
    return in_array($value, ['1', 'true', 'yes', 'y', 'on', 'debug'], true);
})();

$printScheduleDebugLog = [];
$printScheduleDebugCompleted = false;
$printScheduleDebugStart = microtime(true);

$printScheduleFatalHandler = static function (): void {
    global $printScheduleDebugCompleted;
    if ($printScheduleDebugCompleted) {
        return;
    }
    $error = error_get_last();
    if ($error === null) {
        return;
    }

    $fatalTypes = [E_ERROR, E_PARSE, E_CORE_ERROR, E_COMPILE_ERROR, E_USER_ERROR];
    if (!in_array($error['type'], $fatalTypes, true)) {
        return;
    }

    print_schedule_debug_respond(
        500,
        'fatal_error',
        'Printable schedule encountered a fatal error before completing.',
        [
            'message' => $error['message'] ?? 'Unknown error',
            'file'    => $error['file'] ?? '',
            'line'    => $error['line'] ?? 0,
            'type'    => $error['type'] ?? 0,
        ]
    );
};

register_shutdown_function($printScheduleFatalHandler);

function print_schedule_debug_enabled(): bool
{
    return !empty($GLOBALS['printScheduleDebugMode']);
}

function print_schedule_debug_log(string $code, string $message, array $context = []): void
{
    $now = microtime(true);
    $start = $GLOBALS['printScheduleDebugStart'] ?? $now;
    $entry = [
        'time'    => $now,
        'offset'  => $now - $start,
        'code'    => $code,
        'message' => $message,
        'context' => $context,
    ];

    $GLOBALS['printScheduleDebugLog'][] = $entry;

    if (count($GLOBALS['printScheduleDebugLog']) > 100) {
        $GLOBALS['printScheduleDebugLog'] = array_slice($GLOBALS['printScheduleDebugLog'], -100);
    }
}

function print_schedule_debug_escape($value): string
{
    return htmlspecialchars((string) $value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function print_schedule_render_debug_page(string $code, string $message, array $context): string
{
    $escape = 'print_schedule_debug_escape';
    $log    = $GLOBALS['printScheduleDebugLog'] ?? [];
    ob_start();
    ?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Printable Schedule Debug</title>
    <style>
        body {
            font-family: "Inter", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
            background: #0f172a;
            color: #e2e8f0;
            margin: 0;
            padding: 24px;
            line-height: 1.5;
        }
        .debug-container {
            max-width: 960px;
            margin: 0 auto;
            background: rgba(30, 41, 59, 0.8);
            border: 1px solid rgba(148, 163, 184, 0.35);
            border-radius: 16px;
            padding: 24px;
        }
        h1 {
            margin-top: 0;
            font-size: 1.5rem;
        }
        .debug-code {
            font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 0.95rem;
            color: #facc15;
        }
        .debug-context {
            margin-top: 16px;
            padding: 12px;
            background: rgba(15, 23, 42, 0.6);
            border-radius: 12px;
            border: 1px solid rgba(148, 163, 184, 0.2);
            font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 0.85rem;
            white-space: pre-wrap;
            word-break: break-word;
        }
        .debug-log {
            margin-top: 24px;
        }
        .debug-log h2 {
            font-size: 1.1rem;
            margin-bottom: 12px;
        }
        .debug-log-list {
            list-style: none;
            margin: 0;
            padding: 0;
            display: grid;
            gap: 10px;
        }
        .debug-log-item {
            background: rgba(15, 23, 42, 0.6);
            border-radius: 12px;
            border: 1px solid rgba(148, 163, 184, 0.25);
            padding: 12px;
        }
        .debug-log-item strong {
            display: block;
            font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 0.82rem;
            color: #facc15;
        }
        .debug-log-context {
            margin-top: 8px;
            font-family: "JetBrains Mono", "SFMono-Regular", Menlo, monospace;
            font-size: 0.78rem;
            white-space: pre-wrap;
        }
    </style>
</head>
<body>
<div class="debug-container" data-print-debug-code="<?= $escape($code); ?>" data-print-debug-message="<?= $escape($message); ?>">
    <h1>Printable schedule error</h1>
    <p class="debug-code">Error code: <?= $escape($code); ?></p>
    <p><?= $escape($message); ?></p>
    <?php if ($context !== []): ?>
        <div class="debug-context"><?= $escape(json_encode($context, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES)); ?></div>
    <?php endif; ?>
    <section class="debug-log">
        <h2>Event log</h2>
        <ol class="debug-log-list">
            <?php foreach ($log as $entry): ?>
                <li class="debug-log-item">
                    <strong><?= $escape($entry['code'] ?? 'event'); ?></strong>
                    <div><?= $escape($entry['message'] ?? ''); ?></div>
                    <div class="debug-log-context">
                        Offset: <?= $escape(number_format((float) ($entry['offset'] ?? 0), 3)); ?>s
                        <?php if (!empty($entry['context'])): ?>
                            \n<?= $escape(json_encode($entry['context'], JSON_UNESCAPED_SLASHES)); ?>
                        <?php endif; ?>
                    </div>
                </li>
            <?php endforeach; ?>
        </ol>
    </section>
</div>
</body>
</html>
<?php
    return (string) ob_get_clean();
}

function print_schedule_debug_respond(int $status, string $code, string $message, array $context = []): void
{
    $GLOBALS['printScheduleDebugCompleted'] = true;
    print_schedule_debug_log($code, $message, $context);
    http_response_code($status);

    if (!print_schedule_debug_enabled()) {
        echo $message . ' (Error code: ' . $code . ')';
        exit;
    }

    header('Content-Type: text/html; charset=UTF-8');
    echo print_schedule_render_debug_page($code, $message, $context);
    exit;
}

print_schedule_debug_log('init', 'Starting printable schedule request', [
    'method' => $_SERVER['REQUEST_METHOD'] ?? 'GET',
]);

$token = requestParam('token');
$auth  = verify_api_token($token);
if ($auth === false) {
    print_schedule_debug_respond(403, 'invalid_token', 'Invalid token');
}

$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
if ($companyId === 0) {
    print_schedule_debug_respond(400, 'missing_company_id', 'Missing company_id');
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    print_schedule_debug_respond(403, 'company_forbidden', 'Forbidden');
}

$storeId = (int) requestParam('store_id', 0);
if ($storeId === 0) {
    print_schedule_debug_respond(400, 'missing_store_id', 'Missing store_id');
}
if (!in_array($storeId, $auth['stores'] ?? [], true) || get_store_company_id($storeId) !== $companyId) {
    print_schedule_debug_respond(403, 'store_forbidden', 'Forbidden');
}

set_audit_user($userId);
set_audit_company($companyId);

if (
    empty($auth['isSuperAdmin'])
    && !is_company_admin($userId, $companyId)
    && !user_has_role($userId, $storeId, 'schedule')
    && !user_has_role($userId, $storeId, 'chores')
    && !isAdmin($userId)
) {
    print_schedule_debug_respond(403, 'permission_denied', 'Forbidden');
}

print_schedule_debug_log('auth', 'User authorized for printable schedule', [
    'user_id'    => $userId,
    'company_id' => $companyId,
    'store_id'   => $storeId,
]);

$date = requestParam('date', date('Y-m-d'));
if (!preg_match('/^\d{4}-\d{2}-\d{2}$/', $date)) {
    $date = date('Y-m-d');
}

print_schedule_debug_log('date', 'Resolved schedule date', ['date' => $date]);

$schedule = fetchSchedule($storeId);
$data     = $schedule[$date] ?? ['employees' => []];
$format   = strtolower((string) requestParam('format', 'html'));
$policy   = fetch_break_policy($storeId, $companyId);
$breakDefaults = [
    'break1' => max(1, (int) ($policy['break1Duration'] ?? 10)),
    'lunch'  => max(1, (int) ($policy['lunchDuration'] ?? 30)),
    'break2' => max(1, (int) ($policy['break2Duration'] ?? 10)),
];

if (isset($data['employees']) && is_array($data['employees'])) {
    foreach ($data['employees'] as &$emp) {
        $breaks = is_array($emp['breaks'] ?? null) ? $emp['breaks'] : [];
        $normalized = [];
        $usedBreakIndexes = [];
        $mapping = [
            ['key' => 'break1', 'durationKey' => 'break1Duration', 'default' => $breakDefaults['break1']],
            ['key' => 'lunch', 'durationKey' => 'lunchDuration', 'default' => $breakDefaults['lunch']],
            ['key' => 'break2', 'durationKey' => 'break2Duration', 'default' => $breakDefaults['break2']],
        ];

        foreach ($mapping as $index => $config) {
            $existing     = [];
            $matchedIndex = null;

            foreach ($breaks as $candidateIndex => $candidate) {
                if (!is_array($candidate) || isset($usedBreakIndexes[$candidateIndex])) {
                    continue;
                }
                $candidateType = strtolower((string) ($candidate['type'] ?? ''));
                if ($candidateType === $config['key']) {
                    $existing     = $candidate;
                    $matchedIndex = $candidateIndex;
                    break;
                }
            }

            if ($matchedIndex === null && isset($breaks[$index]) && !isset($usedBreakIndexes[$index]) && is_array($breaks[$index])) {
                $existing     = $breaks[$index];
                $matchedIndex = $index;
            }

            if ($matchedIndex !== null) {
                $usedBreakIndexes[$matchedIndex] = true;
            }

            $skip = false;
            if (is_array($existing)) {
                $skip = coerceBreakBool($existing['skip'] ?? null) || coerceBreakBool($existing['skipped'] ?? null);
            }

            $suffix = ucfirst($config['key']);
            if (!$skip) {
                $skip = coerceBreakBool($emp[$config['key'] . 'Skipped'] ?? null)
                    || coerceBreakBool($emp[$config['key'] . 'Skip'] ?? null)
                    || coerceBreakBool($emp['skip' . $suffix] ?? null);
            }

            $startValue = '';
            $duration   = '';
            if (!$skip) {
                $startValue = (string) ($existing['start'] ?? ($emp[$config['key']] ?? ''));
                $startValue = trim($startValue);

                $durationValue = $existing['duration'] ?? ($emp[$config['durationKey']] ?? '');
                if (is_string($durationValue)) {
                    $durationValue = trim($durationValue);
                }
                $durationInt = is_numeric($durationValue) ? (int) $durationValue : 0;
                if ($durationInt <= 0) {
                    $durationInt = $config['default'];
                }
                $duration = $startValue === '' ? '' : (string) $durationInt;
            }

            if ($skip) {
                $emp[$config['key']] = '';
                $emp[$config['durationKey']] = '';
            } else {
                $emp[$config['key']] = $startValue;
                $emp[$config['durationKey']] = $duration;
            }

            $entry = ['type' => $config['key']];
            if ($skip) {
                $entry['skip'] = true;
            } else {
                if ($startValue !== '') {
                    $entry['start'] = $startValue;
                }
                if ($duration !== '') {
                    $entry['duration'] = (int) $duration;
                }
            }

            $normalized[] = $entry;
        }

        $emp['breaks'] = $normalized;
    }
    unset($emp);
}

assignChoresToSchedule($data, $storeId, $date);

$employeeNames = [];
foreach ($data['employees'] as $emp) {
    if (isset($emp['id'], $emp['name'])) {
        $employeeNames[$emp['id']] = $emp['name'];
    }
}

$tipSource = $data['tips'] ?? ($data['tipTracker'] ?? []);
if ($tipSource instanceof Traversable) {
    $convertedTipSource = [];
    foreach ($tipSource as $key => $value) {
        $convertedTipSource[$key] = $value;
    }
    $tipSource = $convertedTipSource;
}
if (is_string($tipSource)) {
    $decoded = json_decode($tipSource, true);
    if (is_array($decoded)) {
        $tipSource = $decoded;
    } else {
        $trimmed = trim($tipSource);
        $tipSource = $trimmed === '' ? [] : [$trimmed];
    }
}
if ($tipSource === null || $tipSource === '') {
    $tipSource = [];
}
if (!is_array($tipSource)) {
    $tipSource = (array) $tipSource;
}

$tipEntries = [];
foreach ($tipSource as $tipEntry) {
    if ($tipEntry instanceof Traversable) {
        $convertedTipEntry = [];
        foreach ($tipEntry as $key => $value) {
            $convertedTipEntry[$key] = $value;
        }
        $tipEntry = $convertedTipEntry;
    } elseif (is_object($tipEntry)) {
        $tipEntry = (array) $tipEntry;
    } elseif (is_scalar($tipEntry) && !is_string($tipEntry)) {
        $tipEntry = (string) $tipEntry;
    }
    $tipEntries[] = normalizeTipEntry($tipEntry);
}
$tipRows    = 8;

$employeeCount = is_array($data['employees'] ?? null) ? count($data['employees']) : 0;
$trainingEntries = [];
if (isset($data['training']) && is_array($data['training'])) {
    $trainingEntries = array_values($data['training']);
}
$trainingEntryCount = count($trainingEntries);
$choreTemplates = loadChores($date, $storeId);

print_schedule_debug_log('schedule_loaded', 'Schedule data assembled', [
    'employees' => $employeeCount,
    'tips'      => count($tipEntries ?? []),
    'training'  => $trainingEntryCount,
]);

$layoutSizing = computePrintLayoutSizing($employeeCount, $tipRows, $trainingEntryCount);

print_schedule_debug_log('layout', 'Layout sizing computed', $layoutSizing);

$tipRows     = max(1, (int) ($layoutSizing['tip_rows'] ?? $tipRows));
$tipEntries  = array_slice($tipEntries, 0, $tipRows);
for ($i = count($tipEntries); $i < $tipRows; $i++) {
    $tipEntries[] = ['', '', '', ''];
}

$scheduleRowCount = max($employeeCount, (int) ($layoutSizing['schedule_rows'] ?? ($layoutSizing['min_rows'] ?? 13)));
$trainingRowCount = max($trainingEntryCount, (int) ($layoutSizing['training_rows'] ?? $trainingEntryCount));
$trainingRowCount = max(1, $trainingRowCount);
$tipRowCount      = max($tipRows, count($tipEntries));

$includePrintJs = $format !== 'pdf';
$isPdf          = $format === 'pdf';
$pdfInlineCss   = '';
$pdfDynamicCss  = '';

if ($isPdf) {
    $cssFiles = [
        __DIR__ . '/../assets/css/bootstrap_print_subset.css',
        __DIR__ . '/../assets/css/print.css',
    ];

    foreach ($cssFiles as $cssFile) {
        if (is_string($cssFile) && is_readable($cssFile)) {
            $css = file_get_contents($cssFile);
            if ($css !== false) {
                $pdfInlineCss .= "\n" . $css;
            }
        }
    }

    if (!empty($layoutSizing)) {
        $pdfDynamicCss = generatePdfLayoutCss($layoutSizing);
    }
}

auditLog('print', 'schedule', $storeId);

print_schedule_debug_log('render:start', 'Rendering printable schedule output', [
    'format' => $format,
    'pdf'    => $isPdf,
]);

if ($isPdf) {
    require_once __DIR__ . '/../../scripts/dompdf/autoload.inc.php';

    $pdfHtml = renderSchedulePdf(
        $date,
        $data['employees'] ?? [],
        $tipEntries,
        $employeeNames,
        $scheduleRowCount,
        $tipRowCount,
        $trainingRowCount,
        $trainingEntries,
        $choreTemplates
    );

    $projectRoot = realpath(__DIR__ . '/../../');
    if ($projectRoot === false) {
        $projectRoot = __DIR__ . '/../../';
    }

    $options = new Dompdf\Options();
    $options->setChroot($projectRoot);
    $options->setIsRemoteEnabled(true);

    $dompdf = new Dompdf\Dompdf($options);
    $dompdf->loadHtml($pdfHtml);
    $dompdf->setPaper('letter', 'landscape');
    $dompdf->render();
    $dompdf->stream('schedule.pdf', ['Attachment' => false]);
    $GLOBALS['printScheduleDebugCompleted'] = true;
    print_schedule_debug_log('render:pdf_complete', 'PDF stream sent to browser');
    exit;
}

$debugEnabled    = print_schedule_debug_enabled();
$debugLogEntries = $GLOBALS['printScheduleDebugLog'] ?? [];

ob_start();
require __DIR__ . '/../../src/views/print_schedule_view.php';
$html = (string) ob_get_clean();

echo $html;

print_schedule_debug_log('render:html_complete', 'Printable schedule HTML rendered successfully');
$GLOBALS['printScheduleDebugCompleted'] = true;
