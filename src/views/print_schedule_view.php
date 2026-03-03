<?php
declare(strict_types=1);

$layoutSizing   = $layoutSizing ?? [];
$includePrintJs = $includePrintJs ?? true;
$isPdf          = $isPdf ?? false;
$styleVariables   = [];
$pdfInlineCss     = $pdfInlineCss ?? '';
$pdfDynamicCss    = $pdfDynamicCss ?? '';
$trainingEntries = isset($trainingEntries) && is_array($trainingEntries)
    ? array_values($trainingEntries)
    : [];
$debugEnabled    = $debugEnabled ?? false;
$debugLogEntries = isset($debugLogEntries) && is_array($debugLogEntries) ? array_values($debugLogEntries) : [];
$formatDebugTime = static function ($value): string {
    if (!is_numeric($value)) {
        return '0.000s';
    }

    return number_format((float) $value, 3) . 's';
};
$debugSummary = ['code' => 'debug_success', 'message' => 'Printable schedule rendered successfully.'];
if ($debugEnabled && $debugLogEntries !== []) {
    $lastEntry = $debugLogEntries[count($debugLogEntries) - 1];
    if (is_array($lastEntry)) {
        $debugSummary['code'] = (string) ($lastEntry['code'] ?? 'debug_success');
        $debugSummary['message'] = (string) ($lastEntry['message'] ?? 'Printable schedule rendered successfully.');
    }
}

$containerStyle     = $isPdf ? '' : 'height:100vh;';
$leftColumnStyle    = $isPdf ? '' : 'height:100%; flex:0 0 70%; max-width:70%;';
$rightColumnStyle   = $isPdf ? '' : 'height:100%; flex:0 0 30%; max-width:30%;';
$scheduleCardStyle = $isPdf ? '' : 'flex:0 0 70%; max-height:70%; height:70%;';
$sideCardStyle     = $isPdf ? '' : 'flex:0 0 calc(50% - 0.25rem); max-height:calc(50% - 0.25rem); height:calc(50% - 0.25rem);';

$employees         = is_array($data['employees'] ?? null) ? $data['employees'] : [];
$empCount          = count($employees);
$trainingCount     = count($trainingEntries);
$scheduleRows      = max((int) ($layoutSizing['schedule_rows'] ?? ($layoutSizing['min_rows'] ?? 13)), $empCount);
$tipRowCount       = max(1, (int) ($layoutSizing['tip_rows'] ?? count($tipEntries)));
$trainingRowCount  = max(1, (int) ($layoutSizing['training_rows'] ?? 5));
$visibleTrainings  = min($trainingRowCount, $trainingCount);
if ($isPdf && !empty($layoutSizing)) {
    $styleVariables['--thead-h']         = (int) ($layoutSizing['thead_height'] ?? 34) . 'px';
    $styleVariables['--row-h']           = (int) ($layoutSizing['row_height'] ?? 18) . 'px';
    $styleVariables['--tip-row-h']       = (int) ($layoutSizing['tip_row_height'] ?? 14) . 'px';
    $styleVariables['--training-row-h']  = (int) ($layoutSizing['training_row_height'] ?? 14) . 'px';
    $styleVariables['--body-exact-h']    = (int) ($layoutSizing['body_height'] ?? 480) . 'px';
    $styleVariables['--card-header-h']   = (int) ($layoutSizing['card_header_height'] ?? 34) . 'px';
    $styleVariables['--page-inner-h']    = (int) ($layoutSizing['page_inner_height'] ?? 768) . 'px';
    $styleVariables['--schedule-card-h'] = (int) ($layoutSizing['schedule_card_height'] ?? 560) . 'px';
    $styleVariables['--schedule-body-h'] = (int) ($layoutSizing['schedule_body_height'] ?? 520) . 'px';
    $styleVariables['--training-card-h'] = (int) ($layoutSizing['training_card_height'] ?? 220) . 'px';
    $styleVariables['--training-body-h'] = (int) ($layoutSizing['training_body_height'] ?? 180) . 'px';
    $styleVariables['--tip-card-h']      = (int) ($layoutSizing['tip_card_height'] ?? 220) . 'px';
    $styleVariables['--tip-body-h']      = (int) ($layoutSizing['tip_body_height'] ?? 180) . 'px';
}

$containerAttr    = $containerStyle !== '' ? ' style="' . h($containerStyle) . '"' : '';
$leftColumnAttr   = $leftColumnStyle !== '' ? ' style="' . h($leftColumnStyle) . '"' : '';
$rightColumnAttr  = $rightColumnStyle !== '' ? ' style="' . h($rightColumnStyle) . '"' : '';
$scheduleCardAttr = $scheduleCardStyle !== '' ? ' style="' . h($scheduleCardStyle) . '"' : '';
$sideCardAttr     = $sideCardStyle !== '' ? ' style="' . h($sideCardStyle) . '"' : '';
$trainingCardAttr = $sideCardAttr;

?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <title>Print Schedule</title>
<?php if (!$isPdf): ?>
    <link
        rel="icon"
        href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg"
        type="image/svg+xml"
    >
<?php endif; ?>
<?php if ($isPdf): ?>
<?php if ($pdfInlineCss !== ''): ?>
    <style>
<?= $pdfInlineCss; ?>
    </style>
<?php endif; ?>
<?php if ($pdfDynamicCss !== ''): ?>
    <style>
<?= $pdfDynamicCss; ?>
    </style>
<?php endif; ?>
<?php if (!empty($styleVariables)): ?>
    <style>
        :root {
<?php foreach ($styleVariables as $name => $value): ?>
            <?= $name; ?>: <?= $value; ?>;
<?php endforeach; ?>
        }
    </style>
<?php endif; ?>
<?php else: ?>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="../assets/css/print.css">
<?php endif; ?>
</head>
<body>
<div class="container-fluid py-2 d-flex flex-column print-page"<?= $containerAttr; ?>>
    <h1 class="h5 mb-2">Staff Schedule — <?= date('F j, Y', strtotime($date)); ?></h1>
    <div class="d-flex flex-fill gap-2 layout-grid">
        <div class="d-flex flex-column gap-2 layout-column layout-column-left"<?= $leftColumnAttr; ?>>
            <div class="card schedule-card"<?= $scheduleCardAttr; ?>>
                <div class="card-header">Schedule</div>
                <div class="card-body">
                    <table class="table table-sm table-bordered mb-0 schedule-table">
                        <thead>
                        <tr>
                            <th class="text-break">Employee</th>
                            <th class="text-nowrap">Shift</th>
                            <th class="text-nowrap schedule-pos-header">POS #</th>
                            <th class="text-nowrap">Break 1</th>
                            <th class="text-nowrap">Lunch</th>
                            <th class="text-nowrap">Break 2</th>
                            <th class="text-break">Chores</th>
                        </tr>
                        </thead>
<?php
$coerceBoolean = static function ($value): bool {
    if (is_bool($value)) {
        return $value;
    }
    if (is_int($value)) {
        return $value !== 0;
    }
    if (is_float($value)) {
        return abs($value) > 0.0000001;
    }
    if (is_string($value)) {
        $normalized = strtolower(trim($value));
        if ($normalized === '' || $normalized === '0' || $normalized === 'false' || $normalized === 'no' || $normalized === 'n') {
            return false;
        }
        if ($normalized === '1' || $normalized === 'true' || $normalized === 'yes' || $normalized === 'y') {
            return true;
        }
    }
    return false;
};

$isBreakSkipped = static function (array $employee, array $break, string $type) use ($coerceBoolean): bool {
    if ($coerceBoolean($break['skip'] ?? null) || $coerceBoolean($break['skipped'] ?? null)) {
        return true;
    }
    $suffix = ucfirst($type);
    if ($coerceBoolean($employee[$type . 'Skipped'] ?? null)) {
        return true;
    }
    if ($coerceBoolean($employee[$type . 'Skip'] ?? null)) {
        return true;
    }
    if ($coerceBoolean($employee['skip' . $suffix] ?? null)) {
        return true;
    }
    return false;
};

$breakDisplay = static function (array $employee, array $break, string $type) use ($isBreakSkipped): string {
    if ($isBreakSkipped($employee, $break, $type)) {
        return 'X';
    }
    $start = (string) ($break['start'] ?? '');
    $duration = (string) ($break['duration'] ?? '');
    if ($start === '') {
        return '';
    }
    return timeRange($start, $duration);
};

$buildBreakCell = static function (string $display): array {
    $classes = ['text-nowrap'];
    if ($display === 'X') {
        $classes[] = 'schedule-break-skip';
        return [
            'class' => implode(' ', $classes),
            'value' => 'X',
        ];
    }

    return [
        'class' => implode(' ', $classes),
        'value' => formatTime($display),
    ];
};
?>
        <tbody>
<?php foreach ($employees as $i => $emp): ?>
        <tr class="<?= $i % 2 ? 'schedule-row-even' : 'schedule-row-odd'; ?>">
            <td class="text-break"><?= h($emp['name'] ?? ''); ?></td>
                            <td class="text-nowrap"><?= formatTime($emp['shift'] ?? ''); ?></td>
                            <td class="text-nowrap schedule-pos-cell"><?= h($emp['pos'] ?? ''); ?></td>
<?php
$b1    = $emp['breaks'][0] ?? ['start' => '', 'duration' => ''];
$lunch = $emp['breaks'][1] ?? ['start' => '', 'duration' => ''];
$b2    = $emp['breaks'][2] ?? ['start' => '', 'duration' => ''];
$b1Display = $breakDisplay($emp, is_array($b1) ? $b1 : [], 'break1');
$lunchDisplay = $breakDisplay($emp, is_array($lunch) ? $lunch : [], 'lunch');
$b2Display = $breakDisplay($emp, is_array($b2) ? $b2 : [], 'break2');
$b1Cell = $buildBreakCell($b1Display);
$lunchCell = $buildBreakCell($lunchDisplay);
$b2Cell = $buildBreakCell($b2Display);
?>
                            <td class="<?= $b1Cell['class']; ?>"><?= $b1Cell['value']; ?></td>
                            <td class="<?= $lunchCell['class']; ?>"><?= $lunchCell['value']; ?></td>
                            <td class="<?= $b2Cell['class']; ?>"><?= $b2Cell['value']; ?></td>
                            <td class="text-break chores-cell">
<?php if (!empty($emp['tasks']) && is_array($emp['tasks'])):
    foreach ($emp['tasks'] as $task):
        $cls = 'task-pill';
        if (($task['type'] ?? '') === 'recycling') {
            $cls .= ' recycling-task';
        }
        if (($task['type'] ?? '') === 'arca') {
            $cls .= ' arca-task';
        }
?>
                                <span class="<?= $cls; ?>"><?= h($task['description'] ?? ''); ?></span>
<?php endforeach; endif; ?>
                            </td>
        </tr>
<?php endforeach; ?>
<?php for ($i = $empCount; $i < $scheduleRows; $i++): ?>
        <tr class="<?= $i % 2 ? 'schedule-row-even' : 'schedule-row-odd'; ?>">
            <td class="text-break"></td>
                            <td class="text-nowrap"></td>
                            <td class="text-nowrap schedule-pos-cell"></td>
                            <td class="text-nowrap"></td>
                            <td class="text-nowrap"></td>
                            <td class="text-nowrap"></td>
                            <td class="text-break"></td>
                        </tr>
<?php endfor; ?>
        </tbody>
                    </table>
                </div>
            </div>
        </div>
        <div class="d-flex flex-column gap-2 layout-column layout-column-right"<?= $rightColumnAttr; ?>>
            <div class="card tip-card"<?= $sideCardAttr; ?>>
                <div class="card-header">Tip Tracker</div>
                <div class="card-body">
                    <table class="table table-sm table-bordered mb-0 text-center tip-table">
                        <thead>
                        <tr>
                            <th>Bag#</th>
                            <th>Amt</th>
                            <th>Init</th>
                            <th>Time</th>
                        </tr>
                        </thead>
                        <tbody>
<?php foreach ($tipEntries as $tip):
    [$bag, $amount, $initials, $time] = normalizeTipEntry($tip);
?>
                            <tr>
                                <td><?= h($bag); ?></td>
                                <td><?= h($amount); ?></td>
                                <td><?= h($initials); ?></td>
                                <td><?= formatTime($time); ?></td>
                            </tr>
<?php endforeach; ?>
<?php for ($i = count($tipEntries); $i < $tipRowCount; $i++): ?>
                        <tr>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                        </tr>
<?php endfor; ?>
                        </tbody>
                    </table>
                </div>
            </div>
            <div class="card training-card"<?= $trainingCardAttr; ?>>
                <div class="card-header">Training</div>
                <div class="card-body">
                    <table class="table table-sm table-bordered mb-0 training-table">
                        <colgroup>
                            <col style="width:34%">
                            <col style="width:33%">
                            <col style="width:33%">
                        </colgroup>
                        <thead>
                        <tr>
                            <th class="text-break">Trainee</th>
                            <th class="text-break">Trainer</th>
                            <th class="text-break">Topic</th>
                        </tr>
                        </thead>
                        <tbody>
<?php for ($i = 0; $i < $visibleTrainings; $i++):
    $training = $trainingEntries[$i] ?? null;
    $trainee  = $training && is_array($training) ? pickStringValue($training, ['trainee', 'employee', 'name']) : '';
    $trainer  = $training && is_array($training) ? pickStringValue($training, ['trainer', 'supervisor']) : '';
    $topic    = $training && is_array($training) ? pickStringValue($training, ['topic', 'subject']) : '';
?>
                        <tr>
                            <td class="text-break"><?= $trainee !== '' ? h($trainee) : ''; ?></td>
                            <td class="text-break"><?= $trainer !== '' ? h($trainer) : ''; ?></td>
                            <td class="text-break"><?= $topic !== '' ? h($topic) : ''; ?></td>
                        </tr>
<?php endfor; ?>
<?php for ($i = $visibleTrainings; $i < $trainingRowCount; $i++): ?>
                        <tr>
                            <td class="text-break"></td>
                            <td class="text-break"></td>
                            <td class="text-break"></td>
                        </tr>
<?php endfor; ?>
                        </tbody>
                    </table>
                </div>
            </div>
        </div>
    </div>
</div>
<?php if ($debugEnabled): ?>
<aside class="print-debug-overlay" data-print-debug-code="<?= h($debugSummary['code']); ?>" data-print-debug-message="<?= h($debugSummary['message']); ?>">
    <h2 class="print-debug-overlay__title">Printable schedule debug log</h2>
    <ol class="print-debug-overlay__list">
        <?php foreach ($debugLogEntries as $entry):
            $entryCode = (string) ($entry['code'] ?? 'event');
            $entryMessage = (string) ($entry['message'] ?? '');
            $entryOffset = $formatDebugTime($entry['offset'] ?? 0);
            $entryContext = is_array($entry['context'] ?? null) ? $entry['context'] : [];
        ?>
        <li class="print-debug-overlay__item">
            <div class="print-debug-overlay__meta">
                <span class="print-debug-overlay__offset">+<?= h($entryOffset); ?></span>
                <span class="print-debug-overlay__code"><?= h($entryCode); ?></span>
            </div>
            <div class="print-debug-overlay__message"><?= h($entryMessage); ?></div>
            <?php if ($entryContext !== []): ?>
            <pre class="print-debug-overlay__context"><?= h(json_encode($entryContext, JSON_UNESCAPED_SLASHES)); ?></pre>
            <?php endif; ?>
        </li>
        <?php endforeach; ?>
    </ol>
</aside>
<?php endif; ?>
<?php if ($includePrintJs): ?>
<script src="../assets/js/print.js"></script>
<?php if (!$isPdf): ?>
<script>
  (() => {
    const MESSAGE_TYPE_CLOSE = "scheduler:print:close";
    let printRequested = false;
    let closeScheduled = false;

    function closeOrPostMessage() {
      if (closeScheduled) {
        return;
      }
      closeScheduled = true;
      const payload = { type: MESSAGE_TYPE_CLOSE };
      if (window.parent && window.parent !== window) {
        window.parent.postMessage(payload, window.location.origin);
        return;
      }
      window.close();
      window.setTimeout(() => {
        if (window.closed) {
          return;
        }
        if (window.history.length > 1) {
          window.history.back();
          return;
        }
        window.location.replace("about:blank");
      }, 300);
    }

    function triggerPrint() {
      if (printRequested) {
        return;
      }
      printRequested = true;
      window.setTimeout(() => {
        try {
          window.focus();
        } catch (error) {
          /* noop */
        }
        try {
          window.print();
        } catch (error) {
          printRequested = false;
        }
      }, 0);
    }

    function startPrintWhenReady() {
      const begin = () => {
        window.setTimeout(triggerPrint, 250);
      };

      if (
        document.fonts &&
        typeof document.fonts.ready === "object" &&
        typeof document.fonts.ready.then === "function"
      ) {
        document.fonts.ready.then(begin).catch(begin);
      } else {
        begin();
      }
    }

    window.addEventListener("load", startPrintWhenReady, { once: true });

    window.addEventListener(
      "afterprint",
      () => {
        if (printRequested) {
          closeOrPostMessage();
        }
      },
      { once: true },
    );

    window.addEventListener("focus", () => {
      if (printRequested && !closeScheduled) {
        window.setTimeout(closeOrPostMessage, 200);
      }
    });
  })();
</script>
<?php endif; ?>
<?php endif; ?>
</body>
</html>
