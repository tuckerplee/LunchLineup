<?php
declare(strict_types=1);

/**
 * Parse raw schedule text and return structured array.
 */
function parse_schedule_text(string $raw, int $companyId, ?int $storeId = null, bool $debug = false): array
{
    $staffMap = [];
    foreach (fetchStaff(null, $companyId, false) as $emp) {
        $first = strtolower(trim(preg_split('/\s+/', $emp['name'])[0] ?? ''));
        if ($first !== '') {
            $staffMap[$first] = $emp;
        }
    }

    $schedule    = [];
    $current     = null;
    $pendingPos  = null;
    $pendingName = null;
    $lines       = preg_split('/\r?\n/', $raw);

    $clean = [];
    foreach ($lines as $ln) {
        $t = trim($ln);
        if ($t === '' || preg_match('/All\s+Schedule/i', $t) || preg_match('/^Schedule Date:/i', $t) || preg_match('#https?://#i', $t) || preg_match('/^\d+\/\d+$/', $t)) {
            continue;
        }
        $clean[] = $t;
    }
    $lines = $clean;

    $tableParsed = false;
    $lineCount   = count($lines);
    for ($h = 0; $h < $lineCount - 1; $h++) {
        $dayParts = preg_split('/\s{2,}/', trim($lines[$h]));
        if (count($dayParts) < 7) {
            continue;
        }
        $allDays = true;
        foreach ($dayParts as $p) {
            if (!preg_match('/^(Sun|Mon|Tue|Wed|Thu|Fri|Sat)/i', trim($p))) {
                $allDays = false;
                break;
            }
        }
        if (!$allDays) {
            continue;
        }

        $dateParts = preg_split('/\s{2,}/', trim($lines[$h + 1] ?? ''));
        if (count($dateParts) < 7) {
            continue;
        }

        for ($i = 0; $i < 7; $i++) {
            $ts  = strtotime($dateParts[$i]);
            $key = $ts ? date('Y-m-d', $ts) : null;
            if ($key) {
                $schedule[$key] = ['employees' => []];
                $dateParts[$i]  = $key;
            } else {
                $dateParts[$i] = null;
            }
        }

        $r = $h + 2;
        for (; $r + 2 < $lineCount; $r += 3) {
            $posParts   = preg_split('/\s{2,}/', trim($lines[$r]));
            $nameParts  = preg_split('/\s{2,}/', trim($lines[$r + 1] ?? ''));
            $shiftParts = preg_split('/\s{2,}/', trim($lines[$r + 2] ?? ''));
            if (count($nameParts) === 0 || count($shiftParts) === 0) {
                continue;
            }
            for ($c = 0; $c < 7; $c++) {
                $dateKey = $dateParts[$c] ?? null;
                if (!$dateKey) {
                    continue;
                }
                $pos   = trim($posParts[$c] ?? '');
                $name  = trim($nameParts[$c] ?? '');
                $shift = trim($shiftParts[$c] ?? '');
                if ($name === '' || $shift === '') {
                    continue;
                }
                $norm = parse_shift_window($shift);
                if (!$norm) {
                    continue;
                }
                $posUp = strtoupper($pos);
                if (preg_match('/^INV\s+RET/', $posUp) || $posUp === 'TIME OFF VAC') {
                    continue;
                }
                if (!preg_match('/^([^,]+),\s*([A-Za-z\'\-]+)/', $name, $nm)) {
                    continue;
                }
                $first = ucfirst(strtolower($nm[2]));
                $emp        = $staffMap[strtolower($first)] ?? ['id' => null, 'lunchDuration' => 30];
                $lunchDur   = (int) ($emp['lunchDuration'] ?? 30);
                $schedule[$dateKey]['employees'][] = [
                    'id'      => $emp['id'],
                    'name'    => $first,
                    'shift'   => $norm,
                    'pos'     => $pos,
                    'breaks'  => [
                        ['start' => '10:30 AM', 'duration' => 10],
                        ['start' => '12:30 PM', 'duration' => $lunchDur],
                        ['start' => '2:30 PM', 'duration' => 10],
                    ],
                    'tasks'   => [],
                    'signOff' => ''
                ];
            }
        }
        $tableParsed = true;
        $h = $r - 1;
    }

    if (!$tableParsed) {
        $dayDateNum   = '/^(Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)\s+(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})/i';
        $dayOnly      = '/^(Sun(?:day)?|Mon(?:day)?|Tue(?:sday)?|Wed(?:nesday)?|Thu(?:rsday)?|Fri(?:day)?|Sat(?:urday)?)$/i';
        $dateOnlyNum  = '/^(\d{1,2}[\/\-]\d{1,2}[\/\-]\d{2,4})$/';

        $N = count($lines);
        for ($i = 0; $i < $N; $i++) {
            $line = trim($lines[$i]);
            if ($line === '') {
                continue;
            }
            if (preg_match($dayDateNum, $line, $m)) {
                $ts      = strtotime($m[2]);
                $current = $ts ? date('Y-m-d', $ts) : null;
                if ($current && !isset($schedule[$current])) {
                    $schedule[$current] = ['employees' => []];
                }
                $pendingName = $pendingPos = null;
                continue;
            }
            if (preg_match($dayOnly, $line, $mDay)) {
                $next = trim($lines[$i + 1] ?? '');
                if (preg_match($dateOnlyNum, $next)) {
                    $ts      = strtotime($mDay[1] . ' ' . $next);
                    $current = $ts ? date('Y-m-d', $ts) : null;
                    if ($current && !isset($schedule[$current])) {
                        $schedule[$current] = ['employees' => []];
                    }
                    $pendingName = $pendingPos = null;
                    $i++;
                    continue;
                }
                $current     = null;
                $pendingName = $pendingPos = null;
                continue;
            }
            if (preg_match($dateOnlyNum, $line, $dOnly)) {
                $ts      = strtotime($dOnly[1]);
                $current = $ts ? date('Y-m-d', $ts) : null;
                if ($current && !isset($schedule[$current])) {
                    $schedule[$current] = ['employees' => []];
                }
                $pendingName = $pendingPos = null;
                continue;
            }
            if (preg_match('/^[A-Za-z][A-Za-z\s]+$/', $line)) {
                $pendingPos = $line;
                continue;
            }
            if (preg_match('/^([^,]+),\s*([A-Za-z\'\-]+)/', $line)) {
                $pendingName = $line;
                continue;
            }
            if ($current) {
                $window = $line . ' ' . ($lines[$i + 1] ?? '') . ' ' . ($lines[$i + 2] ?? '');
                $shift = parse_shift_window($window);
                if ($shift) {
                    if ($pendingName && preg_match('/^([^,]+),\s*([A-Za-z\'\-]+)/', $pendingName, $mn)) {
                        $pos = $pendingPos ?? '';
                        if ($pos === '' && preg_match('/^\s*\d{1,2}(?:\:\d{2})?\s*[AP]M?\s*[-]\s*\d{1,2}(?:\:\d{2})?\s*[AP]M?\s+(.*)$/i', $line, $pm)) {
                            $candidate = trim($pm[1]);
                            if ($candidate !== '' && preg_match('/^[A-Za-z][A-Za-z\s]+$/', $candidate)) {
                                $pos = $candidate;
                            }
                        }
                        if ($pos === '' && preg_match('/^[A-Za-z][A-Za-z\s]+$/', trim($lines[$i + 1] ?? ''))) {
                            $pos = trim($lines[$i + 1]);
                            $i++;
                        }
                        $posUp = strtoupper($pos);
                        if (preg_match('/^INV\s+RET/', $posUp) || $posUp === 'TIME OFF VAC') {
                            $pendingName = $pendingPos = null;
                            continue;
                        }
                        $first = ucfirst(strtolower($mn[2]));
                        $emp      = $staffMap[strtolower($first)] ?? ['id' => null, 'lunchDuration' => 30];
                        $lunchDur = (int) ($emp['lunchDuration'] ?? 30);
                        $schedule[$current]['employees'][] = [
                            'id'      => $emp['id'],
                            'name'    => $first,
                            'shift'   => $shift,
                            'pos'     => $pos,
                            'breaks'  => [
                                ['start' => '10:30 AM', 'duration' => 10],
                                ['start' => '12:30 PM', 'duration' => $lunchDur],
                                ['start' => '2:30 PM', 'duration' => 10],
                            ],
                            'tasks'   => [],
                            'signOff' => ''
                        ];
                    }
                    $pendingName = $pendingPos = null;
                    continue;
                }
            }
        }
    }

    $response = ['status' => 'ok', 'schedule' => $schedule];
    if ($debug) {
        $nonEmpty = array_values(array_filter(array_map('trim', $lines), fn($x) => $x !== ''));
        $response['debugPreview'] = array_slice($nonEmpty, 0, 60);
    }

    return $response;
}

function normaliseTime(string $t): string
{
    $t = strtoupper(preg_replace('/\s+/', '', $t));

    if (preg_match('/^(\d{1,2})(?:\:(\d{2}))?([AP]M?)?$/', $t, $m)) {
        $h = (int) $m[1];
        $min = $m[2] !== null ? $m[2] : '00';
        $suffix = $m[3] ?? '';
        if ($suffix === 'A') {
            $suffix = 'AM';
        } elseif ($suffix === 'P') {
            $suffix = 'PM';
        }
        if ($suffix === '') {
            $suffix = $h >= 12 ? 'PM' : 'AM';
            if ($h === 0) {
                $h = 12;
            } elseif ($h > 12) {
                $h -= 12;
            }
        }
        return sprintf('%d:%02d %s', $h, (int) $min, $suffix);
    }

    if (preg_match('/^(\d{2})(\d{2})$/', $t, $m)) {
        $h = (int) $m[1];
        $min = $m[2];
        $suffix = $h >= 12 ? 'PM' : 'AM';
        if ($h === 0) {
            $h = 12;
        } elseif ($h > 12) {
            $h -= 12;
        }
        return sprintf('%d:%02d %s', $h, (int) $min, $suffix);
    }

    return $t;
}

function parse_shift_window(string $text): ?string
{
    $text = trim($text);

    if (stripos($text, 'ALL') !== false) {
        return null;
    }

    $pattern = '/(\d{1,2}(?:\:\d{2})?\s*[AP]M?)\s*[-]\s*(\d{1,2}(?:\:\d{2})?\s*[AP]M?)/i';
    if (preg_match($pattern, $text, $m)) {
        return normaliseTime($m[1]) . '-' . normaliseTime($m[2]);
    }

    $clean = strtoupper(preg_replace('/\s+/', '', $text));
    if (preg_match('/^(\d{3,4})-(\d{3,4})$/', $clean, $m)) {
        return normaliseTime($m[1]) . '-' . normaliseTime($m[2]);
    }

    return null;
}
