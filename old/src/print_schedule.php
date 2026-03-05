<?php
declare(strict_types=1);

function loadChores(string $date, int $storeId): array
{
    $scheduleDate = DateTimeImmutable::createFromFormat('Y-m-d', $date);
    if ($scheduleDate === false) {
        return [];
    }

    $chores    = fetchChores($storeId);
    $dayOfWeek = (int) $scheduleDate->format('w');

    return array_values(array_filter($chores, static function ($chore) use ($dayOfWeek, $scheduleDate) {
        if (empty($chore['isActive'])) {
            return false;
        }

        if (empty($chore['autoAssignEnabled'])) {
            return false;
        }

        $showOnDays = $chore['showOnDays'] ?? null;
        if (is_array($showOnDays) && $showOnDays !== [] && !in_array($dayOfWeek, $showOnDays, true)) {
            return false;
        }

        $frequency = strtolower(trim((string) ($chore['frequency'] ?? 'daily')));
        $interval  = max(1, (int) ($chore['recurrenceInterval'] ?? 1));

        switch ($frequency) {
            case 'daily':
            case 'per_shift':
                if (((int) $scheduleDate->format('z')) % $interval !== 0) {
                    return false;
                }
                break;
            case 'weekly':
                $weekIndex = (int) $scheduleDate->format('W');
                if (($weekIndex - 1) % $interval !== 0) {
                    return false;
                }
                break;
            case 'monthly':
                $monthIndex = ((int) $scheduleDate->format('Y') * 12) + (int) $scheduleDate->format('n');
                if ($monthIndex % $interval !== 0) {
                    return false;
                }
                break;
            case 'once':
            default:
                break;
        }

        $windowStart = parseScheduleDate($chore['windowStart'] ?? null);
        if ($windowStart instanceof DateTimeImmutable && $scheduleDate < $windowStart) {
            return false;
        }

        $windowEnd = parseScheduleDate($chore['windowEnd'] ?? null);
        if ($windowEnd instanceof DateTimeImmutable && $scheduleDate > $windowEnd) {
            return false;
        }

        if ($windowStart instanceof DateTimeImmutable && $windowEnd instanceof DateTimeImmutable && $windowStart > $windowEnd) {
            return false;
        }

        return true;
    }));
}

if (!function_exists('print_schedule_log_warning')) {
    function print_schedule_log_warning(string $message, array $context = [], ?string $dedupeKey = null): void
    {
        static $seen = [];

        if ($dedupeKey !== null) {
            if (isset($seen[$dedupeKey])) {
                return;
            }
            $seen[$dedupeKey] = true;
        }

        $payload = [
            'component' => 'scheduler:autoAssign',
            'message'   => $message,
        ];

        if ($context !== []) {
            $payload['context'] = $context;
        }

        $encoded = json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_UNESCAPED_UNICODE);
        if ($encoded === false) {
            $encoded = 'scheduler:autoAssign ' . $message;
            if ($context !== []) {
                $encoded .= ' ' . var_export($context, true);
            }
        }

        error_log($encoded);
    }
}

function assignChoresToSchedule(array &$scheduleDay, int $storeId, string $date): void
{
    if (!isset($scheduleDay['employees']) || !is_array($scheduleDay['employees'])) {
        return;
    }

    $chores = loadChores($date, $storeId);
    if ($chores === []) {
        return;
    }

    usort($chores, static function (array $a, array $b): int {
        $priorityComparison = ($b['priority'] ?? 0) <=> ($a['priority'] ?? 0);
        if ($priorityComparison !== 0) {
            return $priorityComparison;
        }

        return ($a['id'] ?? 0) <=> ($b['id'] ?? 0);
    });

    $staff          = fetchStaff($storeId);
    $preferenceMap  = [];
    $staffMeta      = [];
    foreach ($staff as $member) {
        $staffId = (int) ($member['id'] ?? 0);
        if ($staffId <= 0) {
            continue;
        }

        $staffMeta[$staffId] = $member;

        $tasks = $member['tasks'] ?? [];
        if (!is_array($tasks) || $tasks === []) {
            continue;
        }

        $idPreferences = [];
        $namePreferences = [];
        foreach ($tasks as $task) {
            if (is_int($task)) {
                if ($task > 0) {
                    $idPreferences[$task] = true;
                }
                continue;
            }

            if (is_float($task)) {
                $intTask = (int) $task;
                if ($intTask > 0) {
                    $idPreferences[$intTask] = true;
                }
                continue;
            }

            if (is_string($task)) {
                $trimmed = trim($task);
                if ($trimmed === '') {
                    continue;
                }
                if (preg_match('/^-?\d+$/', $trimmed) === 1) {
                    $intTask = (int) $trimmed;
                    if ($intTask > 0) {
                        $idPreferences[$intTask] = true;
                    }
                } else {
                    $namePreferences[strtolower($trimmed)] = true;
                }
                continue;
            }

        }

        if ($idPreferences !== [] || $namePreferences !== []) {
            $preferenceMap[$staffId] = [
                'ids'   => $idPreferences,
                'names' => $namePreferences,
            ];
        }
    }

    foreach ($scheduleDay['employees'] as &$employee) {
        if (!isset($employee['tasks']) || !is_array($employee['tasks'])) {
            $employee['tasks'] = [];
            continue;
        }

        $employee['tasks'] = array_values(array_filter(
            $employee['tasks'],
            static function ($task): bool {
                if (!is_array($task)) {
                    return true;
                }

                return empty($task['autoAssigned']);
            }
        ));
    }
    unset($employee);

    $scheduleById = [];
    $assignmentCounts = [];
    $perChoreAssignments = [];
    $perChoreAssignmentsByLabel = [];
    $perEmployeeChoreCounts = [];
    $perEmployeeLabelCounts = [];
    $orderMap = [];

    $normalizeList = static function ($value): array {
        if ($value === null) {
            return [];
        }
        if (is_string($value)) {
            $value = preg_split('/[\s,]+/', $value) ?: [];
        }
        if (!is_array($value)) {
            return [];
        }
        $items = [];
        foreach ($value as $item) {
            if (!is_scalar($item)) {
                continue;
            }
            $trimmed = trim((string) $item);
            if ($trimmed === '' || in_array($trimmed, $items, true)) {
                continue;
            }
            $items[] = $trimmed;
        }
        return $items;
    };

    $extractTaskLabel = static function ($task): ?string {
        if (is_array($task)) {
            $value = $task['description'] ?? $task['name'] ?? '';
        } else {
            $value = $task;
        }
        if (!is_scalar($value)) {
            return null;
        }
        $trimmed = strtolower(trim((string) $value));
        return $trimmed === '' ? null : $trimmed;
    };

    $extractTaskKey = static function ($task) use ($extractTaskLabel): ?string {
        if (is_array($task)) {
            foreach (['choreId', 'chore_id'] as $idKey) {
                if (isset($task[$idKey]) && is_numeric($task[$idKey])) {
                    $taskId = (int) $task[$idKey];
                    if ($taskId > 0) {
                        return 'id:' . $taskId;
                    }
                }
            }
        }

        $label = $extractTaskLabel($task);
        if ($label === null) {
            return null;
        }

        return 'label:' . $label;
    };

    foreach ($scheduleDay['employees'] as $index => &$employee) {
        $employeeId = isset($employee['id']) ? (int) $employee['id'] : 0;
        if ($employeeId <= 0) {
            continue;
        }

        $scheduleById[$employeeId] = &$employee;
        $assignmentCounts[$employeeId] = count(array_filter(
            $employee['tasks'],
            static fn ($task) => is_array($task) || is_string($task)
        ));
        $orderMap[$employeeId] = $index;

        foreach ($employee['tasks'] as $task) {
            if (is_array($task)) {
                if (($task['type'] ?? null) !== 'chore') {
                    continue;
                }
            } elseif (!is_string($task)) {
                continue;
            }

            $taskKey = $extractTaskKey($task);
            if ($taskKey === null) {
                continue;
            }

            $perChoreAssignments[$taskKey] = ($perChoreAssignments[$taskKey] ?? 0) + 1;
            if (!isset($perEmployeeChoreCounts[$employeeId])) {
                $perEmployeeChoreCounts[$employeeId] = [];
            }
            $perEmployeeChoreCounts[$employeeId][$taskKey] = ($perEmployeeChoreCounts[$employeeId][$taskKey] ?? 0) + 1;

            $label = $extractTaskLabel($task);
            if ($label !== null) {
                $perChoreAssignmentsByLabel[$label] = ($perChoreAssignmentsByLabel[$label] ?? 0) + 1;
                if (!isset($perEmployeeLabelCounts[$employeeId])) {
                    $perEmployeeLabelCounts[$employeeId] = [];
                }
                $perEmployeeLabelCounts[$employeeId][$label] = ($perEmployeeLabelCounts[$employeeId][$label] ?? 0) + 1;
            }
        }

    }
    unset($employee);

    if ($scheduleById === []) {
        return;
    }

    $choreDefinitionCounts = [];
    foreach ($chores as $template) {
        $templateDescription = trim((string) ($template['description'] ?? ''));
        if ($templateDescription === '') {
            continue;
        }
        $templateLabel = strtolower($templateDescription);
        $choreDefinitionCounts[$templateLabel] = ($choreDefinitionCounts[$templateLabel] ?? 0) + 1;
    }

    $parseShiftBounds = static function ($value): array {
        if ($value === null) {
            return [null, null];
        }

        if (!is_scalar($value)) {
            return [null, null];
        }

        $text = trim((string) $value);
        if ($text === '') {
            return [null, null];
        }

        $startRaw = null;
        $endRaw   = null;

        if (preg_match(
            '/(\d{1,2}(?::\d{2}){0,2}\s*(?:am?|pm?)?)[^\dA-Za-z]*[-–—][^\dA-Za-z]*'
            . '(\d{1,2}(?::\d{2}){0,2}\s*(?:am?|pm?)?)/iu',
            $text,
            $matches
        ) === 1) {
            $startRaw = trim($matches[1]);
            $endRaw   = trim($matches[2]);
        } else {
            preg_match_all('/\d{1,2}(?::\d{2}){0,2}\s*(?:am?|pm?)?/iu', $text, $tokens);
            if (isset($tokens[0]) && count($tokens[0]) >= 2) {
                $startRaw = trim((string) $tokens[0][0]);
                $endRaw   = trim((string) $tokens[0][1]);
            }
        }

        if ($startRaw === null && $endRaw === null) {
            return [null, null];
        }

        $startMinutes = null;
        $endMinutes   = null;

        if ($startRaw !== null && $startRaw !== '') {
            $startComponents = print_schedule_time_components($startRaw);
            if ($startComponents !== null) {
                $startMinutes = ($startComponents['hours'] * 60) + $startComponents['minutes'];
            }
        }

        if ($endRaw !== null && $endRaw !== '') {
            $endComponents = print_schedule_time_components($endRaw);
            if ($endComponents !== null) {
                $endMinutes = ($endComponents['hours'] * 60) + $endComponents['minutes'];
            }
        }

        if ($startMinutes !== null && $endMinutes !== null && $endMinutes <= $startMinutes) {
            $endMinutes += 24 * 60;
        }

        return [$startMinutes, $endMinutes];
    };

    $profiles = [];
    foreach ($scheduleById as $employeeId => $employee) {
        $staffRecord = $staffMeta[$employeeId] ?? [];

        $metadata = [];
        if (isset($staffRecord['metadata']) && is_array($staffRecord['metadata'])) {
            $metadata = array_merge($metadata, $staffRecord['metadata']);
        }
        if (isset($employee['metadata']) && is_array($employee['metadata'])) {
            $metadata = array_merge($metadata, $employee['metadata']);
        }

        $employeeName = null;
        foreach (['name', 'full_name'] as $nameKey) {
            foreach ([$employee, $staffRecord] as $nameSource) {
                if (!is_array($nameSource) || !isset($nameSource[$nameKey])) {
                    continue;
                }
                $candidateName = trim((string) $nameSource[$nameKey]);
                if ($candidateName !== '') {
                    $employeeName = $candidateName;
                    break 2;
                }
            }
        }

        $positionSources = [
            $staffRecord['pos'] ?? null,
            $staffRecord['positions'] ?? null,
            $metadata['positions'] ?? null,
            $employee['positions'] ?? null,
            $employee['pos'] ?? null,
        ];
        $positions = [];
        foreach ($positionSources as $value) {
            foreach ($normalizeList($value) as $item) {
                if (!in_array($item, $positions, true)) {
                    $positions[] = $item;
                }
            }
        }

        $skillSources = [
            $staffRecord['skills'] ?? null,
            $metadata['skills'] ?? null,
            $employee['skills'] ?? null,
        ];
        $skills = [];
        foreach ($skillSources as $value) {
            foreach ($normalizeList($value) as $item) {
                if (!in_array($item, $skills, true)) {
                    $skills[] = $item;
                }
            }
        }

        $staffLevel = null;
        foreach ([
            $metadata,
            $staffRecord,
            $employee,
        ] as $source) {
            foreach (['staffLevel', 'staff_level', 'level'] as $key) {
                if (isset($source[$key]) && is_numeric($source[$key])) {
                    $staffLevel = (int) $source[$key];
                    break 2;
                }
            }
        }

        $autoAssignOptOut = false;
        $sourceBuckets = [
            'metadata'     => $metadata,
            'staffRecord'  => $staffRecord,
            'scheduleRow'  => $employee,
        ];

        foreach ($sourceBuckets as $bucketName => $source) {
            if (!is_array($source)) {
                continue;
            }
            if (!empty($source['autoAssignOptOut']) || !empty($source['auto_assign_opt_out'])) {
                $autoAssignOptOut = true;
                break;
            }
            if (array_key_exists('autoAssign', $source) && empty($source['autoAssign'])) {
                $autoAssignOptOut = true;
                break;
            }
        }

        $explicitCloser = false;
        $explicitOpener = false;
        $closerSignals = [];
        $openerSignals = [];

        foreach ($sourceBuckets as $bucketName => $source) {
            if (!is_array($source)) {
                continue;
            }

            foreach ([
                'isCloser',
                'is_closer',
                'closer',
                'autoIsCloser',
                'auto_is_closer',
            ] as $closerKey) {
                if (!empty($source[$closerKey])) {
                    $explicitCloser = true;
                    $closerSignals[] = $bucketName . '.' . $closerKey;
                }
            }

            foreach ([
                'isOpener',
                'is_opener',
                'opener',
                'autoIsOpener',
                'auto_is_opener',
            ] as $openerKey) {
                if (!empty($source[$openerKey])) {
                    $explicitOpener = true;
                    $openerSignals[] = $bucketName . '.' . $openerKey;
                }
            }

            $role = isset($source['assignmentRole']) ? $source['assignmentRole'] : ($source['assignment_role'] ?? null);
            if (is_string($role) && $role !== '') {
                $normalizedRole = strtolower($role);
                if ($normalizedRole === 'closer') {
                    $explicitCloser = true;
                    $closerSignals[] = $bucketName . '.assignmentRole=closer';
                }
                if ($normalizedRole === 'opener') {
                    $explicitOpener = true;
                    $openerSignals[] = $bucketName . '.assignmentRole=opener';
                }
            }

            foreach (['assignmentTags', 'assignment_tags'] as $tagKey) {
                if (!isset($source[$tagKey]) || !is_array($source[$tagKey])) {
                    continue;
                }
                $tags = $source[$tagKey];
                foreach (['isCloser', 'is_closer', 'closer'] as $candidateTag) {
                    if (!empty($tags[$candidateTag])) {
                        $explicitCloser = true;
                        $closerSignals[] = $bucketName . '.' . $tagKey . '.' . $candidateTag;
                    }
                }
                foreach (['isOpener', 'is_opener', 'opener'] as $candidateTag) {
                    if (!empty($tags[$candidateTag])) {
                        $explicitOpener = true;
                        $openerSignals[] = $bucketName . '.' . $tagKey . '.' . $candidateTag;
                    }
                }
            }
        }

        $heuristicCloser = false;
        $closerHeuristics = [];
        foreach ($positions as $position) {
            if (!is_string($position)) {
                continue;
            }

            $normalizedPosition = strtolower($position);
            if (str_contains($normalizedPosition, 'closer') || str_contains($normalizedPosition, 'close')) {
                $heuristicCloser = true;
                $closerHeuristics[] = 'position:' . $position;
                break;
            }
        }

        $shiftText = strtolower(trim((string) ($employee['shift'] ?? '')));
        if (!$heuristicCloser && $shiftText !== '' && str_contains($shiftText, 'close')) {
            $heuristicCloser = true;
            $closerHeuristics[] = 'shift:' . $shiftText;
        }

        $signOffText = strtolower(trim((string) ($employee['signOff'] ?? '')));
        if (!$heuristicCloser && $signOffText !== '' && str_contains($signOffText, 'close')) {
            $heuristicCloser = true;
            $closerHeuristics[] = 'signOff:' . $signOffText;
        }

        [$shiftStartMinutes, $shiftEndMinutes] = $parseShiftBounds($employee['shift'] ?? null);

        $heuristicOpener = false;
        $openerHeuristics = [];
        foreach ($positions as $position) {
            if (!is_string($position)) {
                continue;
            }

            $normalizedPosition = strtolower($position);
            if (str_contains($normalizedPosition, 'opener') || str_contains($normalizedPosition, 'open')) {
                $heuristicOpener = true;
                $openerHeuristics[] = 'position:' . $position;
                break;
            }
        }

        if (!$heuristicOpener && $shiftText !== '' && str_contains($shiftText, 'open')) {
            $heuristicOpener = true;
            $openerHeuristics[] = 'shift:' . $shiftText;
        }

        if (!$heuristicOpener && $signOffText !== '' && str_contains($signOffText, 'open')) {
            $heuristicOpener = true;
            $openerHeuristics[] = 'signOff:' . $signOffText;
        }

        $isCloser = $explicitCloser || $heuristicCloser;
        $isOpener = $explicitOpener || $heuristicOpener;

        if ($explicitCloser && $explicitOpener) {
            print_schedule_log_warning(
                'conflicting opener/closer flags detected',
                array_filter([
                    'employeeId'        => $employeeId,
                    'employeeName'      => $employeeName,
                    'closerSignals'     => $closerSignals,
                    'openerSignals'     => $openerSignals,
                ], static fn ($value) => $value !== null && $value !== []),
                'conflict:explicit:' . $employeeId
            );
        }

        if ($explicitCloser && !$explicitOpener && $heuristicOpener) {
            print_schedule_log_warning(
                'opener heuristics conflict with explicit closer flag',
                array_filter([
                    'employeeId'        => $employeeId,
                    'employeeName'      => $employeeName,
                    'closerSignals'     => $closerSignals,
                    'openerHeuristics'  => $openerHeuristics,
                ], static fn ($value) => $value !== null && $value !== []),
                'conflict:closer-heuristic-open:' . $employeeId
            );
        }

        if ($explicitOpener && !$explicitCloser && $heuristicCloser) {
            print_schedule_log_warning(
                'closer heuristics conflict with explicit opener flag',
                array_filter([
                    'employeeId'        => $employeeId,
                    'employeeName'      => $employeeName,
                    'openerSignals'     => $openerSignals,
                    'closerHeuristics'  => $closerHeuristics,
                ], static fn ($value) => $value !== null && $value !== []),
                'conflict:opener-heuristic-close:' . $employeeId
            );
        }

        if (!$explicitCloser && !$explicitOpener && $heuristicCloser && $heuristicOpener) {
            print_schedule_log_warning(
                'employee matches both opener and closer heuristics',
                array_filter([
                    'employeeId'        => $employeeId,
                    'employeeName'      => $employeeName,
                    'closerHeuristics'  => $closerHeuristics,
                    'openerHeuristics'  => $openerHeuristics,
                ], static fn ($value) => $value !== null && $value !== []),
                'conflict:heuristic-both:' . $employeeId
            );
        }

        $profiles[$employeeId] = [
            'positions'         => $positions,
            'skills'            => $skills,
            'staffLevel'        => $staffLevel,
            'autoAssignOptOut'  => $autoAssignOptOut,
            'isCloser'          => $isCloser,
            'isOpener'          => $isOpener,
            'shiftStartMinutes' => $shiftStartMinutes,
            'shiftEndMinutes'   => $shiftEndMinutes,
        ];
    }

    $openerCloserWindow = 90;

    $endMinutes = array_values(array_filter(
        array_map(
            static fn (array $profile) => $profile['shiftEndMinutes'] ?? null,
            $profiles
        ),
        static fn ($value) => $value !== null
    ));

    if ($endMinutes !== []) {
        $latestEnd = max($endMinutes);
        foreach ($profiles as &$profile) {
            if (!($profile['isCloser'] ?? false)) {
                $end = $profile['shiftEndMinutes'] ?? null;
                if ($end !== null && $end <= $latestEnd && $end >= $latestEnd - $openerCloserWindow) {
                    $profile['isCloser'] = true;
                }
            }
        }
        unset($profile);
    }

    $startMinutes = array_values(array_filter(
        array_map(
            static fn (array $profile) => $profile['shiftStartMinutes'] ?? null,
            $profiles
        ),
        static fn ($value) => $value !== null
    ));

    if ($startMinutes !== []) {
        $earliestStart = min($startMinutes);
        $haveNonClosers = false;
        foreach ($profiles as $profile) {
            if (empty($profile['isCloser'])) {
                $haveNonClosers = true;
                break;
            }
        }
        foreach ($profiles as &$profile) {
            $isCloser = $profile['isCloser'] ?? false;
            if (!($profile['isOpener'] ?? false)
                && ($haveNonClosers ? !$isCloser : true)
            ) {
                $start = $profile['shiftStartMinutes'] ?? null;
                if ($start !== null && $start >= $earliestStart && $start <= $earliestStart + $openerCloserWindow) {
                    $profile['isOpener'] = true;
                }
            }
        }
        unset($profile);
    }

    foreach ($profiles as &$profile) {
        unset($profile['shiftStartMinutes'], $profile['shiftEndMinutes']);
    }
    unset($profile);

    $isCandidateEligible = static function (
        int $employeeId,
        array $profile,
        array $constraints,
        array $perEmployeeChoreCounts,
        array $perEmployeeLabelCounts,
        string $choreKey,
        string $normalized
    ): bool {
        if ($profile['autoAssignOptOut']) {
            print_schedule_log_warning(
                'candidate skipped due to auto-assign opt-out',
                array_filter([
                    'employeeId'   => $employeeId,
                    'chore'        => $normalized,
                ], static fn ($value) => $value !== null && $value !== []),
                'skip:opt-out:' . $employeeId
            );
            return false;
        }

        if (!empty($constraints['excludeCloser']) && $profile['isCloser']) {
            print_schedule_log_warning(
                'candidate skipped because chore excludes closers',
                array_filter([
                    'employeeId'   => $employeeId,
                    'chore'        => $normalized,
                ], static fn ($value) => $value !== null && $value !== []),
                'skip:closer:' . $employeeId . ':' . $choreKey
            );
            return false;
        }

        if (!empty($constraints['excludeOpener']) && $profile['isOpener']) {
            print_schedule_log_warning(
                'candidate skipped because chore excludes openers',
                array_filter([
                    'employeeId'   => $employeeId,
                    'chore'        => $normalized,
                ], static fn ($value) => $value !== null && $value !== []),
                'skip:opener:' . $employeeId . ':' . $choreKey
            );
            return false;
        }

        $keyAssignmentCount = $perEmployeeChoreCounts[$employeeId][$choreKey] ?? 0;
        $labelAssignmentCount = $perEmployeeLabelCounts[$employeeId][$normalized] ?? 0;
        $effectiveAssignmentCount = max($keyAssignmentCount, $labelAssignmentCount);

        $maxPerShift = $constraints['maxPerShift'];
        if ($maxPerShift !== null && $maxPerShift > 0) {
            if ($effectiveAssignmentCount >= $maxPerShift) {
                print_schedule_log_warning(
                    'candidate reached chore shift limit',
                    array_filter([
                        'employeeId'   => $employeeId,
                        'chore'        => $normalized,
                        'maxPerShift'  => $maxPerShift,
                        'assigned'     => $effectiveAssignmentCount,
                    ], static fn ($value) => $value !== null && $value !== []),
                    'skip:max-shift:' . $employeeId . ':' . $choreKey
                );
                return false;
            }
        }

        $maxPerEmployeePerDay = $constraints['maxPerEmployeePerDay'];
        if ($maxPerEmployeePerDay !== null && $maxPerEmployeePerDay > 0) {
            if ($effectiveAssignmentCount >= $maxPerEmployeePerDay) {
                print_schedule_log_warning(
                    'candidate reached chore daily limit',
                    array_filter([
                        'employeeId'     => $employeeId,
                        'chore'          => $normalized,
                        'maxPerEmployee' => $maxPerEmployeePerDay,
                        'assigned'       => $effectiveAssignmentCount,
                    ], static fn ($value) => $value !== null && $value !== []),
                    'skip:max-day:' . $employeeId . ':' . $choreKey
                );
                return false;
            }
        }

        return true;
    };

    $prefersChore = static function (array $map, int $candidateId, int $choreId, string $normalized): bool {
        if (!isset($map[$candidateId]) || !is_array($map[$candidateId])) {
            return false;
        }

        $prefs = $map[$candidateId];

        if ($choreId > 0
            && isset($prefs['ids'])
            && is_array($prefs['ids'])
            && isset($prefs['ids'][$choreId])
        ) {
            return true;
        }

        if ($normalized !== ''
            && isset($prefs['names'])
            && is_array($prefs['names'])
            && isset($prefs['names'][$normalized])
        ) {
            return true;
        }

        return false;
    };

    $eligibleHeadcount = 0;
    foreach ($profiles as $profile) {
        if (!($profile['autoAssignOptOut'] ?? false)) {
            $eligibleHeadcount++;
        }
    }

    foreach ($chores as $chore) {
        if (empty($chore['autoAssignEnabled'])) {
            continue;
        }

        $description = trim((string) ($chore['description'] ?? ''));
        if ($description === '') {
            continue;
        }

        $normalized = strtolower($description);
        $choreId = isset($chore['id']) ? (int) $chore['id'] : 0;
        $choreKey = $choreId > 0 ? 'id:' . $choreId : 'label:' . $normalized;

        $allowMultiple = !empty($chore['allowMultipleAssignees']);
        $keyAssigned = $perChoreAssignments[$choreKey] ?? 0;
        $labelAssigned = $perChoreAssignmentsByLabel[$normalized] ?? 0;
        $definitionCount = $choreDefinitionCounts[$normalized] ?? 1;

        if (!$allowMultiple && ($keyAssigned > 0 || $labelAssigned >= $definitionCount)) {
            print_schedule_log_warning(
                'chore already assigned for this schedule run',
                array_filter([
                    'choreId'          => $choreId,
                    'chore'            => $normalized,
                    'assignedCount'    => $labelAssigned,
                    'definitionCount'  => $definitionCount,
                    'keyAssignments'   => $keyAssigned,
                    'allowMultiple'    => $allowMultiple,
                ], static fn ($value) => $value !== null && $value !== []),
                'skip:assigned:' . $choreKey
            );
            continue;
        }

        $maxPerDay = isset($chore['maxPerDay']) ? (int) $chore['maxPerDay'] : null;
        if ($maxPerDay !== null && $maxPerDay > 0 && $labelAssigned >= $maxPerDay) {
            print_schedule_log_warning(
                'chore reached daily assignment limit',
                array_filter([
                    'choreId'       => $choreId,
                    'chore'         => $normalized,
                    'assignedCount' => $labelAssigned,
                    'maxPerDay'     => $maxPerDay,
                ], static fn ($value) => $value !== null && $value !== []),
                'skip:max-day-total:' . $choreKey
            );
            continue;
        }

        $minStaffLevel = null;
        foreach (['minStaffLevel', 'min_staff_level'] as $minLevelKey) {
            if (!isset($chore[$minLevelKey]) || $chore[$minLevelKey] === null) {
                continue;
            }

            $candidateMin = $chore[$minLevelKey];
            if (is_numeric($candidateMin)) {
                $minStaffLevel = (int) $candidateMin;
                break;
            }
        }

        $maxPerShift = isset($chore['maxPerShift']) && $chore['maxPerShift'] !== null
            ? (int) $chore['maxPerShift']
            : (isset($chore['max_per_shift']) && $chore['max_per_shift'] !== null ? (int) $chore['max_per_shift'] : null);
        $maxPerEmployeePerDay = isset($chore['maxPerEmployeePerDay']) && $chore['maxPerEmployeePerDay'] !== null
            ? (int) $chore['maxPerEmployeePerDay']
            : (isset($chore['max_per_employee_per_day']) && $chore['max_per_employee_per_day'] !== null
                ? (int) $chore['max_per_employee_per_day']
                : null);

        if ($minStaffLevel !== null && $minStaffLevel > 0 && $eligibleHeadcount < $minStaffLevel) {
            continue;
        }

        $constraints = [
            'excludeCloser' => !empty($chore['excludeCloser']),
            'excludeOpener' => !empty($chore['excludeOpener']),
            'maxPerShift' => $maxPerShift,
            'maxPerEmployeePerDay' => $maxPerEmployeePerDay,
        ];

        $buildCandidateIds = static function (array $flags) use (
            $scheduleById,
            $profiles,
            $isCandidateEligible,
            &$perEmployeeChoreCounts,
            &$perEmployeeLabelCounts,
            $choreKey,
            $normalized
        ): array {
            $candidateIds = [];
            foreach ($scheduleById as $candidateId => $_employee) {
                $profile = $profiles[$candidateId] ?? null;
                if ($profile === null) {
                    continue;
                }
                if (!$isCandidateEligible(
                    $candidateId,
                    $profile,
                    $flags,
                    $perEmployeeChoreCounts,
                    $perEmployeeLabelCounts,
                    $choreKey,
                    $normalized
                )) {
                    continue;
                }
                $candidateIds[] = $candidateId;
            }

            return $candidateIds;
        };

        $constraintVariants = [[
            'flags'      => $constraints,
            'relaxed'    => [],
            'candidates' => $buildCandidateIds($constraints),
        ]];

        $baseCandidateCount = count($constraintVariants[0]['candidates']);

        if (!empty($constraints['excludeOpener']) && $baseCandidateCount === 0) {
            $relaxedFlags = array_merge($constraints, ['excludeOpener' => false]);
            $relaxedCandidates = $buildCandidateIds($relaxedFlags);

            if (count($relaxedCandidates) === 1) {
                $constraintVariants[] = [
                    'flags'      => $relaxedFlags,
                    'relaxed'    => ['excludeOpener'],
                    'candidates' => $relaxedCandidates,
                ];
            }
        }

        if (!empty($constraints['excludeCloser']) && $baseCandidateCount === 0) {
            $relaxedFlags = array_merge($constraints, ['excludeCloser' => false]);
            $relaxedCandidates = $buildCandidateIds($relaxedFlags);

            if (count($relaxedCandidates) === 1) {
                $constraintVariants[] = [
                    'flags'      => $relaxedFlags,
                    'relaxed'    => ['excludeCloser'],
                    'candidates' => $relaxedCandidates,
                ];
            }
        }

        if (!empty($constraints['excludeOpener'])
            && !empty($constraints['excludeCloser'])
            && $baseCandidateCount === 0
        ) {
            $relaxedFlags = array_merge($constraints, ['excludeOpener' => false, 'excludeCloser' => false]);
            $relaxedCandidates = $buildCandidateIds($relaxedFlags);

            if (count($relaxedCandidates) === 1) {
                $constraintVariants[] = [
                    'flags'      => $relaxedFlags,
                    'relaxed'    => ['excludeOpener', 'excludeCloser'],
                    'candidates' => $relaxedCandidates,
                ];
            }
        }

        $appliedConstraints = $constraints;
        $relaxedFlags = [];
        $eligible = [];
        $preferred = [];

        $assignedId = null;
        $existingAssignee = isset($chore['assignedTo']) ? (int) $chore['assignedTo'] : 0;
        if ($existingAssignee > 0 && isset($scheduleById[$existingAssignee])) {
            $profile = $profiles[$existingAssignee] ?? null;
            if ($profile !== null && $isCandidateEligible(
                $existingAssignee,
                $profile,
                $constraints,
                $perEmployeeChoreCounts,
                $perEmployeeLabelCounts,
                $choreKey,
                $normalized
            )) {
                $assignedId = $existingAssignee;
            } else {
                print_schedule_log_warning(
                    'existing chore assignee failed eligibility checks',
                    array_filter([
                        'employeeId'   => $existingAssignee,
                        'choreId'      => $choreId,
                        'chore'        => $normalized,
                        'choreKey'     => $choreKey,
                        'constraints'  => $constraints,
                    ], static fn ($value) => $value !== null && $value !== []),
                    'skip:existing:' . $existingAssignee . ':' . $choreKey
                );
            }
        }

        if ($assignedId === null) {
            foreach ($constraintVariants as $variant) {
                $candidateIds = $variant['candidates'] ?? $buildCandidateIds($variant['flags']);

                if ($candidateIds === []) {
                    continue;
                }

                $eligible = $candidateIds;
                $preferred = array_values(array_filter(
                    $candidateIds,
                    static fn (int $candidateId) => $prefersChore($preferenceMap, $candidateId, $choreId, $normalized)
                ));

                $appliedConstraints = $variant['flags'];
                $relaxedFlags = $variant['relaxed'];
                break;
            }

            $candidates = $preferred !== [] ? $preferred : $eligible;
            if ($candidates !== []) {
                usort($candidates, static function (int $a, int $b) use ($assignmentCounts, $orderMap): int {
                    $countComparison = ($assignmentCounts[$a] ?? 0) <=> ($assignmentCounts[$b] ?? 0);
                    if ($countComparison !== 0) {
                        return $countComparison;
                    }

                    return ($orderMap[$a] ?? PHP_INT_MAX) <=> ($orderMap[$b] ?? PHP_INT_MAX);
                });

                $assignedId = $candidates[0] ?? null;

                if ($assignedId !== null && $relaxedFlags !== []) {
                    print_schedule_log_warning(
                        'relaxed chore exclusions to fill assignment',
                        array_filter([
                            'choreId'     => $choreId,
                            'chore'       => $normalized,
                            'choreKey'    => $choreKey,
                            'relaxed'     => $relaxedFlags,
                        ], static fn ($value) => $value !== null && $value !== []),
                        'relax:' . $choreKey . ':' . implode('-', $relaxedFlags)
                    );
                }
            }
        }

        if ($assignedId === null || !isset($scheduleById[$assignedId])) {
            print_schedule_log_warning(
                'no eligible candidate found for chore',
                array_filter([
                    'choreId'         => $choreId,
                    'chore'           => $normalized,
                    'choreKey'        => $choreKey,
                    'eligibleCount'   => isset($eligible) ? count($eligible) : 0,
                    'preferredCount'  => isset($preferred) ? count($preferred) : 0,
                    'constraints'     => $appliedConstraints,
                ], static fn ($value) => $value !== null && $value !== []),
                'skip:none:' . $choreKey
            );
            continue;
        }

        $employee = &$scheduleById[$assignedId];
        $alreadyAssigned = false;
        foreach ($employee['tasks'] as $task) {
            $taskKey = $extractTaskKey($task);
            if ($taskKey === null) {
                continue;
            }
            if ($taskKey === $choreKey) {
                $alreadyAssigned = true;
                break;
            }
        }

        if ($alreadyAssigned) {
            unset($employee);
            continue;
        }

        $newTask = [
            'description' => $description,
            'type'        => 'chore',
            'autoAssigned' => true,
        ];
        if ($choreId > 0) {
            $newTask['choreId'] = $choreId;
        }

        $employee['tasks'][] = $newTask;

        $assignmentCounts[$assignedId] = ($assignmentCounts[$assignedId] ?? 0) + 1;
        $perChoreAssignments[$choreKey] = ($perChoreAssignments[$choreKey] ?? 0) + 1;
        $perChoreAssignmentsByLabel[$normalized] = ($perChoreAssignmentsByLabel[$normalized] ?? 0) + 1;
        if (!isset($perEmployeeChoreCounts[$assignedId])) {
            $perEmployeeChoreCounts[$assignedId] = [];
        }
        $perEmployeeChoreCounts[$assignedId][$choreKey] = ($perEmployeeChoreCounts[$assignedId][$choreKey] ?? 0) + 1;
        if (!isset($perEmployeeLabelCounts[$assignedId])) {
            $perEmployeeLabelCounts[$assignedId] = [];
        }
        $perEmployeeLabelCounts[$assignedId][$normalized] = ($perEmployeeLabelCounts[$assignedId][$normalized] ?? 0) + 1;

        unset($employee);
    }
}

if (!function_exists('print_schedule_chore_name')) {
    function print_schedule_chore_name(array $chore): string
    {
        $name = trim((string) ($chore['name'] ?? ''));
        if ($name !== '') {
            return $name;
        }
        $description = trim((string) ($chore['description'] ?? ''));
        if ($description !== '') {
            return $description;
        }
        return isset($chore['id']) ? 'Chore #' . (int) $chore['id'] : 'Chore';
    }
}

if (!function_exists('print_schedule_time_components')) {
    function print_schedule_time_components($value): ?array
    {
        if ($value === null) {
            return null;
        }
        $raw = trim((string) $value);
        if ($raw === '') {
            return null;
        }
        if (preg_match('/\b\d{1,2}(?::\d{2}){0,2}\s*(?:am?|pm?)\b/i', $raw, $match) === 1) {
            $raw = trim($match[0]);
        } elseif (preg_match('/\b\d{1,2}(?::\d{2}){1,2}\b/', $raw, $match) === 1) {
            $raw = trim($match[0]);
        } elseif (preg_match('/\b\d{1,2}\b/', $raw, $match) === 1) {
            $raw = trim($match[0]);
        }

        if ($raw === '') {
            return null;
        }

        $raw = trim($raw, " \t\n\r\0\x0B,.;");
        if ($raw === '') {
            return null;
        }

        if (preg_match('/([ap])m?/i', $raw, $periodMatch) === 1) {
            $cleaned = preg_replace('/[^0-9:]/', '', $raw);
            if ($cleaned === '') {
                return null;
            }
            $pieces  = explode(':', $cleaned);
            $hours   = isset($pieces[0]) ? (int) $pieces[0] : 0;
            $minutes = isset($pieces[1]) ? (int) $pieces[1] : 0;
            $period  = strtolower($periodMatch[1]);
            if ($period === 'p' && $hours < 12) {
                $hours += 12;
            }
            if ($period === 'a' && $hours === 12) {
                $hours = 0;
            }
        } else {
            if (!preg_match('/^(\d{1,2})(?::(\d{2}))?(?::(\d{2}))?$/', $raw, $matches)) {
                return null;
            }
            $hours   = (int) ($matches[1] ?? 0);
            $minutes = (int) ($matches[2] ?? 0);
        }
        $hours   = $hours % 24;
        $minutes = $minutes % 60;
        return ['hours' => $hours, 'minutes' => $minutes];
    }
}

if (!function_exists('print_schedule_format_chore_time')) {
    function print_schedule_format_chore_time($value): ?string
    {
        $components = print_schedule_time_components($value);
        if ($components === null) {
            return null;
        }
        $hours   = $components['hours'];
        $minutes = $components['minutes'];
        $period  = 'AM';
        $display = $hours;
        if ($hours >= 12) {
            $period = 'PM';
            if ($hours > 12) {
                $display = $hours - 12;
            }
        }
        if ($hours === 0) {
            $display = 12;
        }
        return sprintf('%d:%02d %s', $display, $minutes, $period);
    }
}

if (!function_exists('print_schedule_format_chore_window')) {
    function print_schedule_format_chore_window(array $chore): ?string
    {
        $start = print_schedule_format_chore_time($chore['windowStart'] ?? $chore['window_start'] ?? null);
        $end   = print_schedule_format_chore_time($chore['windowEnd'] ?? $chore['window_end'] ?? null);
        if ($start && $end) {
            return $start . ' – ' . $end;
        }
        if ($start) {
            return 'After ' . $start;
        }
        if ($end) {
            return 'Before ' . $end;
        }
        $daypart = trim((string) ($chore['daypart'] ?? $chore['dayPart'] ?? ''));
        return $daypart !== '' ? ucfirst($daypart) : null;
    }
}

if (!function_exists('print_schedule_format_chore_deadline')) {
    function print_schedule_format_chore_deadline(array $chore): ?string
    {
        $deadline = print_schedule_format_chore_time($chore['deadlineTime'] ?? $chore['deadline_time'] ?? null);
        if ($deadline === null) {
            return null;
        }
        $lead = isset($chore['leadTimeMinutes']) ? (int) $chore['leadTimeMinutes'] : (isset($chore['lead_time_minutes']) ? (int) $chore['lead_time_minutes'] : 0);
        if ($lead > 0) {
            return sprintf('Deadline %s (lead %dm)', $deadline, $lead);
        }
        return 'Deadline ' . $deadline;
    }
}

if (!function_exists('print_schedule_format_chore_days')) {
    function print_schedule_format_chore_days(array $chore, array $dayNames): ?string
    {
        $days = $chore['showOnDays'] ?? null;
        if (!is_array($days) || $days === []) {
            return null;
        }
        $labels = [];
        foreach ($days as $day) {
            $index = (int) $day;
            if ($index < 0 || $index > 6) {
                continue;
            }
            $labels[] = $dayNames[$index] ?? (string) $index;
        }
        if ($labels === []) {
            return null;
        }
        return 'Days ' . implode('/', $labels);
    }
}

if (!function_exists('print_schedule_format_chore_frequency')) {
    function print_schedule_format_chore_frequency(array $chore): ?string
    {
        $frequency = strtolower(trim((string) ($chore['frequency'] ?? '')));
        if ($frequency === '') {
            return null;
        }
        $interval = isset($chore['recurrenceInterval']) ? (int) $chore['recurrenceInterval'] : (isset($chore['recurrence_interval']) ? (int) $chore['recurrence_interval'] : 1);
        if ($interval > 1) {
            switch ($frequency) {
                case 'daily':
                    return "Every {$interval} days";
                case 'weekly':
                    return "Every {$interval} weeks";
                case 'monthly':
                    return "Every {$interval} months";
                case 'per_shift':
                    return "Every {$interval} shifts";
            }
        }
        if ($frequency === 'once') {
            return 'One-time';
        }
        if ($frequency === 'per_shift') {
            return 'Per shift';
        }
        if (in_array($frequency, ['daily', 'weekly', 'monthly'], true)) {
            return ucfirst($frequency);
        }
        return null;
    }
}

if (!function_exists('print_schedule_collect_chore_badges')) {
    function print_schedule_collect_chore_badges(array $chore, array $dayNames): array
    {
        $badges = [];
        $priority = isset($chore['priority']) ? (int) $chore['priority'] : 0;
        if ($priority !== 0) {
            $badges[] = 'Priority ' . $priority;
        }
        $window = print_schedule_format_chore_window($chore);
        if ($window !== null) {
            $badges[] = $window;
        }
        $days = print_schedule_format_chore_days($chore, $dayNames);
        if ($days !== null) {
            $badges[] = $days;
        }
        $frequency = print_schedule_format_chore_frequency($chore);
        if ($frequency !== null) {
            $badges[] = $frequency;
        }
        $deadline = print_schedule_format_chore_deadline($chore);
        if ($deadline !== null) {
            $badges[] = $deadline;
        }
        if (!empty($chore['excludeCloser'])) {
            $badges[] = 'No closers';
        }
        if (!empty($chore['excludeOpener'])) {
            $badges[] = 'No openers';
        }
        $minStaff = isset($chore['minStaffLevel']) ? (int) $chore['minStaffLevel'] : (isset($chore['min_staff_level']) ? (int) $chore['min_staff_level'] : 0);
        if ($minStaff > 0) {
            $badges[] = 'Min staff ' . $minStaff;
        }
        $maxPerDay = isset($chore['maxPerDay']) ? (int) $chore['maxPerDay'] : (isset($chore['max_per_day']) ? (int) $chore['max_per_day'] : 0);
        if ($maxPerDay > 0) {
            $badges[] = 'Cap ' . $maxPerDay . '/day';
        }
        $maxPerShift = isset($chore['maxPerShift']) ? (int) $chore['maxPerShift'] : (isset($chore['max_per_shift']) ? (int) $chore['max_per_shift'] : 0);
        if ($maxPerShift > 0) {
            $badges[] = 'Max ' . $maxPerShift . '/shift';
        }
        $maxPerEmployee = isset($chore['maxPerEmployeePerDay']) ? (int) $chore['maxPerEmployeePerDay'] : (isset($chore['max_per_employee_per_day']) ? (int) $chore['max_per_employee_per_day'] : 0);
        if ($maxPerEmployee > 0) {
            $badges[] = 'Max ' . $maxPerEmployee . '/person';
        }
        $duration = isset($chore['estimatedDurationMinutes']) ? (int) $chore['estimatedDurationMinutes'] : (isset($chore['estimated_duration_minutes']) ? (int) $chore['estimated_duration_minutes'] : 0);
        if ($duration > 0) {
            $badges[] = '≈' . $duration . ' min';
        }
        return $badges;
    }
}

if (!function_exists('print_schedule_chore_assignee')) {
    function print_schedule_chore_assignee(array $chore, array $employeeNames): string
    {
        $assignedId = $chore['assignedTo'] ?? $chore['assigned_to'] ?? null;
        if (is_numeric($assignedId) && (int) $assignedId > 0) {
            $id = (int) $assignedId;
            return $employeeNames[$id] ?? ('#' . $id);
        }
        $assignedName = trim((string) ($chore['assignedToName'] ?? $chore['assigned_to_name'] ?? ''));
        return $assignedName;
    }
}

function parseScheduleDate(mixed $value): ?DateTimeImmutable
{
    if (!is_string($value)) {
        return null;
    }

    $value = trim($value);
    if ($value === '') {
        return null;
    }

    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $value) === 1) {
        $date = DateTimeImmutable::createFromFormat('Y-m-d', $value);
        return $date === false ? null : $date;
    }

    if (preg_match('/^\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}(:\d{2})?$/', $value) === 1) {
        $datePart = substr($value, 0, 10);
        $date     = DateTimeImmutable::createFromFormat('Y-m-d', $datePart);
        return $date === false ? null : $date;
    }

    return null;
}

function h(string $s): string
{
    return htmlspecialchars($s, ENT_QUOTES);
}

function formatTime(string $s): string
{
    $s = htmlspecialchars($s, ENT_QUOTES);
    $s = preg_replace('/\s*-\s*/', ' - ', $s);
    return preg_replace_callback(
        '/\s*(AM|PM)\b/i',
        fn($m) => '<span class="ampm">' . strtolower($m[1]) . '</span>',
        $s
    );
}

function coerceBreakBool(mixed $value): bool
{
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
}

function breakIsSkippedForEmployee(array $break, array $employee = [], string $type = ''): bool
{
    if (coerceBreakBool($break['skip'] ?? null) || coerceBreakBool($break['skipped'] ?? null)) {
        return true;
    }
    if ($type !== '') {
        $suffix = ucfirst($type);
        if (coerceBreakBool($employee[$type . 'Skipped'] ?? null)) {
            return true;
        }
        if (coerceBreakBool($employee[$type . 'Skip'] ?? null)) {
            return true;
        }
        if (coerceBreakBool($employee['skip' . $suffix] ?? null)) {
            return true;
        }
    }
    return false;
}

function buildBreakDisplayValue(array $break, array $employee = [], string $type = ''): string
{
    if (breakIsSkippedForEmployee($break, $employee, $type)) {
        return 'X';
    }
    $start = (string) ($break['start'] ?? '');
    $duration = (string) ($break['duration'] ?? '');
    if ($start === '') {
        return '';
    }
    return timeRange($start, $duration);
}

function timeRange(string $start, string $duration): string
{
    $start = trim($start);
    if ($start === '') {
        return '';
    }

    $ts = strtotime($start);
    if ($ts === false) {
        return $start;
    }

    $minutes = (int) $duration;
    if ($minutes <= 0) {
        return date('g:i A', $ts);
    }

    $end = $ts + ($minutes * 60);
    return date('g:i A', $ts) . '-' . date('g:i A', $end);
}

function computePrintLayoutSizing(
    int $employeeCount,
    int $tipRows = 8,
    int $trainingCount = 0
): array {
    $employeeCount  = max(0, $employeeCount);
    $tipRows        = max(1, $tipRows);
    $trainingCount  = max(0, $trainingCount);

    $minScheduleRows = 13;
    $scheduleRows    = max($minScheduleRows, $employeeCount);

    $minTrainingRows = 12;
    $trainingRows    = max($minTrainingRows, $trainingCount);

    $pageWidth        = 1056; // 11in at 96dpi
    $pageHeight       = 816;  // 8.5in at 96dpi
    $pageMargin       = 24;   // 0.25in margins
    $containerPadding = 16;   // py-2 top + bottom
    $containerPaddingX = 24;  // bootstrap container horizontal padding
    $headingHeight     = 32;  // h5 text + margin-bottom
    $columnGap         = 8;   // gap-2 vertical gap between stacked cards
    $cardHeaderHeight  = 34;
    $theadHeight       = 34;

    $pageInnerHeight = $pageHeight - ($pageMargin * 2);
    if ($pageInnerHeight <= 0) {
        $pageInnerHeight = $pageHeight;
        $pageMargin      = 0;
    }

    $pageInnerWidth = $pageWidth - ($pageMargin * 2);
    if ($pageInnerWidth <= 0) {
        $pageInnerWidth = $pageWidth;
    }

    $containerInnerWidth = $pageInnerWidth - ($containerPaddingX * 2);
    if ($containerInnerWidth <= 0) {
        $containerInnerWidth = $pageInnerWidth;
        $containerPaddingX   = 0;
    }

    $columnHeight = max(480, $pageInnerHeight - $containerPadding - $headingHeight);

    $leftTableCount  = 1; // schedule only
    $rightTableCount = 2; // tip tracker + training

    $bodyAvailableLeft  = $columnHeight - ($cardHeaderHeight * $leftTableCount) - ($theadHeight * $leftTableCount);
    $bodyAvailableRight = $columnHeight - $columnGap - ($cardHeaderHeight * $rightTableCount) - ($theadHeight * $rightTableCount);

    if ($bodyAvailableLeft < 0) {
        $bodyAvailableLeft = 0;
    }
    if ($bodyAvailableRight < 0) {
        $bodyAvailableRight = 0;
    }

    $minScheduleRowHeight = 32;
    $maxScheduleRowHeight = 80;
    $minTipRowHeight      = 16;
    $maxTipRowHeight      = 40;
    $minTrainingRowHeight = 16;
    $maxTrainingRowHeight = 40;

    if ($bodyAvailableLeft <= 0) {
        $scheduleRowHeight = $minScheduleRowHeight;
    } else {
        $scheduleRowHeight = max(
            $minScheduleRowHeight,
            min(
                $maxScheduleRowHeight,
                (int) floor($bodyAvailableLeft / max(1, $scheduleRows))
            )
        );

        while (
            $scheduleRowHeight > $minScheduleRowHeight
            && ($scheduleRowHeight * $scheduleRows) > $bodyAvailableLeft
        ) {
            $scheduleRowHeight--;
        }

        while (
            $scheduleRowHeight < $maxScheduleRowHeight
            && (($scheduleRowHeight + 1) * $scheduleRows) <= $bodyAvailableLeft
        ) {
            $scheduleRowHeight++;
        }
    }

    $trainingRowHeight = $minTrainingRowHeight;
    $tipRowHeight      = $minTipRowHeight;

    if ($bodyAvailableRight > 0) {
        $rightUsed = ($trainingRows * $trainingRowHeight) + ($tipRows * $tipRowHeight);
        while (
            $rightUsed > $bodyAvailableRight
            && ($trainingRowHeight > $minTrainingRowHeight || $tipRowHeight > $minTipRowHeight)
        ) {
            if (
                $trainingRowHeight > $minTrainingRowHeight
                && ($trainingRows >= $tipRows || $tipRowHeight <= $minTipRowHeight)
            ) {
                $trainingRowHeight--;
            } elseif ($tipRowHeight > $minTipRowHeight) {
                $tipRowHeight--;
            } elseif ($trainingRowHeight > $minTrainingRowHeight) {
                $trainingRowHeight--;
            }
            $rightUsed = ($trainingRows * $trainingRowHeight) + ($tipRows * $tipRowHeight);
        }

        while (true) {
            $grown = false;

            if (
                $trainingRowHeight < $maxTrainingRowHeight
                && ($tipRows * $tipRowHeight) + ($trainingRows * ($trainingRowHeight + 1)) <= $bodyAvailableRight
                && ($trainingRows >= $tipRows || $tipRowHeight >= $maxTipRowHeight)
            ) {
                $trainingRowHeight++;
                $grown = true;
            } elseif (
                $tipRowHeight < $maxTipRowHeight
                && ($tipRows * ($tipRowHeight + 1)) + ($trainingRows * $trainingRowHeight) <= $bodyAvailableRight
            ) {
                $tipRowHeight++;
                $grown = true;
            } elseif (
                $trainingRowHeight < $maxTrainingRowHeight
                && ($tipRows * $tipRowHeight) + ($trainingRows * ($trainingRowHeight + 1)) <= $bodyAvailableRight
            ) {
                $trainingRowHeight++;
                $grown = true;
            }

            if (!$grown) {
                break;
            }
        }
    }

    $scheduleBodyHeight = $theadHeight + ($scheduleRows * $scheduleRowHeight);
    $tipBodyHeight      = $theadHeight + ($tipRows * $tipRowHeight);
    $trainingBodyHeight = $theadHeight + ($trainingRows * $trainingRowHeight);

    $scheduleCardHeight = $scheduleBodyHeight + $cardHeaderHeight;
    $tipCardHeight      = $tipBodyHeight + $cardHeaderHeight;
    $trainingCardHeight = $trainingBodyHeight + $cardHeaderHeight;

    $containerHeight = $headingHeight + $containerPadding + $columnHeight;

    $leftColumnWidth  = (int) floor(($containerInnerWidth - $columnGap) * 0.7);
    $minLeftWidth     = 320;
    $minRightWidth    = 260;
    if ($leftColumnWidth < $minLeftWidth) {
        $leftColumnWidth = $minLeftWidth;
    }

    $rightColumnWidth = $containerInnerWidth - $columnGap - $leftColumnWidth;
    if ($rightColumnWidth < $minRightWidth) {
        $rightColumnWidth = $minRightWidth;
        $leftColumnWidth  = $containerInnerWidth - $columnGap - $rightColumnWidth;
        if ($leftColumnWidth < $minLeftWidth) {
            $leftColumnWidth = max($minLeftWidth, (int) floor(($containerInnerWidth - $columnGap) * 0.6));
            $rightColumnWidth = max($minRightWidth, $containerInnerWidth - $columnGap - $leftColumnWidth);
            if ($rightColumnWidth < $minRightWidth) {
                $rightColumnWidth = $minRightWidth;
            }
        }
    }

    if ($leftColumnWidth < 0) {
        $leftColumnWidth = max($minLeftWidth, (int) floor(($containerInnerWidth - $columnGap) * 0.65));
    }
    if ($rightColumnWidth < 0) {
        $rightColumnWidth = max($minRightWidth, $containerInnerWidth - $columnGap - $leftColumnWidth);
    }

    return [
        'thead_height'          => $theadHeight,
        'row_height'            => $scheduleRowHeight,
        'tip_row_height'        => $tipRowHeight,
        'training_row_height'   => $trainingRowHeight,
        'body_height'           => $scheduleBodyHeight,
        'card_header_height'    => $cardHeaderHeight,
        'schedule_rows'         => $scheduleRows,
        'tip_rows'              => $tipRows,
        'training_rows'         => $trainingRows,
        'page_inner_height'     => $containerHeight,
        'page_inner_width'      => $pageInnerWidth,
        'container_inner_width' => $containerInnerWidth,
        'container_padding_x'   => $containerPaddingX,
        'column_height'         => $columnHeight,
        'left_column_width'     => $leftColumnWidth,
        'right_column_width'    => $rightColumnWidth,
        'schedule_card_height'  => $scheduleCardHeight,
        'schedule_body_height'  => $scheduleBodyHeight,
        'training_card_height'  => $trainingCardHeight,
        'training_body_height'  => $trainingBodyHeight,
        'tip_card_height'       => $tipCardHeight,
        'tip_body_height'       => $tipBodyHeight,
        'min_rows'              => $minScheduleRows,
        'page_margin'           => $pageMargin,
        'column_gap'            => $columnGap,
        'scale'                 => null,
        'scale_width_percent'   => null,
    ];
}

function generatePdfLayoutCss(array $layoutSizing): string
{
    if ($layoutSizing === []) {
        return '';
    }

    $normalize = static function ($value): ?string {
        if (!is_numeric($value)) {
            return null;
        }

        $value = (int) round((float) $value);
        if ($value <= 0) {
            return null;
        }

        return $value . 'px';
    };

    $cssSections = [];

    $varMap = [
        '--thead-h'         => 'thead_height',
        '--row-h'           => 'row_height',
        '--tip-row-h'       => 'tip_row_height',
        '--training-row-h'  => 'training_row_height',
        '--body-exact-h'    => 'body_height',
        '--card-header-h'   => 'card_header_height',
        '--page-inner-h'    => 'page_inner_height',
        '--schedule-card-h' => 'schedule_card_height',
        '--schedule-body-h' => 'schedule_body_height',
        '--training-card-h' => 'training_card_height',
        '--training-body-h' => 'training_body_height',
        '--tip-card-h'      => 'tip_card_height',
        '--tip-body-h'      => 'tip_body_height',
    ];

    $varLines = [];
    foreach ($varMap as $cssVar => $key) {
        if (!array_key_exists($key, $layoutSizing)) {
            continue;
        }

        $normalized = $normalize($layoutSizing[$key]);
        if ($normalized === null) {
            continue;
        }

        $varLines[] = '    ' . $cssVar . ': ' . $normalized . ';';
    }

    if ($varLines !== []) {
        $cssSections[] = ":root {\n" . implode("\n", $varLines) . "\n}";
    }

    $addRule = static function (string $selector, array $properties) use (&$cssSections): void {
        $lines = [];
        foreach ($properties as $name => $value) {
            if ($value === null || $value === '') {
                continue;
            }
            $lines[] = '    ' . $name . ': ' . $value . ';';
        }

        if ($lines === []) {
            return;
        }

        $cssSections[] = $selector . " {\n" . implode("\n", $lines) . "\n}";
    };

    $columnHeight = $normalize($layoutSizing['column_height'] ?? null);
    $leftWidth    = $normalize($layoutSizing['left_column_width'] ?? null);
    $rightWidth   = $normalize($layoutSizing['right_column_width'] ?? null);
    $pageWidth    = $normalize($layoutSizing['page_inner_width'] ?? null);
    $pageHeight   = $normalize($layoutSizing['page_inner_height'] ?? ($layoutSizing['container_height'] ?? null));
    $columnGap    = $normalize($layoutSizing['column_gap'] ?? null);

    if ($pageWidth !== null) {
        $addRule('.layout-grid', [
            'max-width' => $pageWidth,
            'width'     => $pageWidth,
        ]);
    }

    if ($pageHeight !== null) {
        $addRule('.print-page', [
            'height'     => $pageHeight,
            'max-height' => $pageHeight,
        ]);
    }

    if ($columnGap !== null) {
        $addRule('.layout-grid', [
            'gap' => $columnGap,
        ]);
    }

    $leftProps = [];
    if ($leftWidth !== null) {
        $leftProps['flex']      = '0 0 ' . $leftWidth;
        $leftProps['max-width'] = $leftWidth;
    }
    if ($columnHeight !== null) {
        $leftProps['height']     = $columnHeight;
        $leftProps['max-height'] = $columnHeight;
    }
    if ($leftProps !== []) {
        $addRule('.layout-column-left', $leftProps);
    }

    $rightProps = [];
    if ($rightWidth !== null) {
        $rightProps['flex']      = '0 0 ' . $rightWidth;
        $rightProps['max-width'] = $rightWidth;
    }
    if ($columnHeight !== null) {
        $rightProps['height']     = $columnHeight;
        $rightProps['max-height'] = $columnHeight;
    }
    if ($rightProps !== []) {
        $addRule('.layout-column-right', $rightProps);
    }

    $scheduleCardHeight = $normalize($layoutSizing['schedule_card_height'] ?? null);
    $scheduleBodyHeight = $normalize($layoutSizing['schedule_body_height'] ?? null);
    $trainingCardHeight = $normalize($layoutSizing['training_card_height'] ?? null);
    $trainingBodyHeight = $normalize($layoutSizing['training_body_height'] ?? null);
    $tipCardHeight      = $normalize($layoutSizing['tip_card_height'] ?? null);
    $tipBodyHeight      = $normalize($layoutSizing['tip_body_height'] ?? null);

    if ($scheduleCardHeight !== null) {
        $addRule('.schedule-card', [
            'height'     => $scheduleCardHeight,
            'max-height' => $scheduleCardHeight,
        ]);
    }
    if ($scheduleBodyHeight !== null) {
        $addRule('.schedule-card .card-body', [
            'height'      => $scheduleBodyHeight,
            'max-height'  => $scheduleBodyHeight,
            'overflow-y'  => 'hidden',
        ]);
    }

    if ($tipCardHeight !== null) {
        $addRule('.tip-card', [
            'height'     => $tipCardHeight,
            'max-height' => $tipCardHeight,
        ]);
    }
    if ($tipBodyHeight !== null) {
        $addRule('.tip-card .card-body', [
            'height'      => $tipBodyHeight,
            'max-height'  => $tipBodyHeight,
            'overflow-y'  => 'hidden',
        ]);
    }

    if ($trainingCardHeight !== null) {
        $addRule('.training-card', [
            'height'     => $trainingCardHeight,
            'max-height' => $trainingCardHeight,
        ]);
    }
    if ($trainingBodyHeight !== null) {
        $addRule('.training-card .card-body', [
            'height'      => $trainingBodyHeight,
            'max-height'  => $trainingBodyHeight,
            'overflow-y'  => 'hidden',
        ]);
    }

    return implode("\n\n", $cssSections);
}

function pickStringValue(array $row, array $keys): string
{
    foreach ($keys as $key) {
        if (!array_key_exists($key, $row)) {
            continue;
        }

        $value = trim((string) $row[$key]);
        if ($value !== '') {
            return $value;
        }
    }

    return '';
}

function normalizeTipEntry($tip): array
{
    $normalized = ['', '', '', ''];

    if (is_array($tip)) {
        for ($i = 0; $i < 4; $i++) {
            if (array_key_exists($i, $tip) && $tip[$i] !== null) {
                $candidate = trim((string) $tip[$i]);
                if ($candidate !== '') {
                    $normalized[$i] = $candidate;
                }
            }
        }

        $fieldMap = [
            0 => ['bag', 'bag_number', 'bagNumber'],
            1 => ['amount', 'amt', 'tip'],
            2 => ['initials', 'init'],
            3 => ['time', 'timestamp'],
        ];

        foreach ($fieldMap as $index => $keys) {
            if ($normalized[$index] !== '') {
                continue;
            }

            $value = pickStringValue($tip, $keys);
            if ($value !== '') {
                $normalized[$index] = $value;
            }
        }
    } elseif (is_string($tip)) {
        $normalized[0] = trim($tip);
    }

    return $normalized;
}

function renderTaskListHtml(array $tasks): string
{
    if ($tasks === []) {
        return '';
    }

    $parts = [];
    foreach ($tasks as $task) {
        if (!is_array($task)) {
            continue;
        }

        $label = pickStringValue($task, ['description', 'label', 'name', 'task']);
        if ($label === '') {
            continue;
        }

        $type = strtolower((string) ($task['type'] ?? ''));
        if ($type === 'recycling') {
            $label = '♻ ' . $label;
        } elseif ($type === 'arca') {
            $label = 'ARCA: ' . $label;
        }

        $parts[] = h($label);
    }

    return implode('<br>', $parts);
}

function renderSchedulePdf(
    string $date,
    array $employees,
    array $tipEntries,
    array $employeeNames,
    int $scheduleRowCount,
    int $tipRowCount,
    int $trainingRowCount,
    array $trainingEntries = [],
    array $choreTemplates = []
): string {
    $scheduleRowCount = max(1, $scheduleRowCount, count($employees));
    $tipRowCount      = max(1, $tipRowCount, count($tipEntries));
    $trainingRowCount = max(1, $trainingRowCount, count($trainingEntries));

    $timestamp   = strtotime($date);
    $displayDate = $timestamp !== false ? date('F j, Y', $timestamp) : $date;

    $employees       = array_values($employees);
    $tipEntries      = array_values($tipEntries);
    $trainingEntries = array_values($trainingEntries);
    ob_start();
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8">
        <title>Staff Schedule — <?= h($displayDate); ?></title>
        <style>
            @page {
                size: letter landscape;
                margin: 0.35in;
            }

            body {
                font-family: "Helvetica", "Arial", sans-serif;
                font-size: 9pt;
                color: #000;
                margin: 0;
            }

            h1 {
                font-size: 16pt;
                text-align: center;
                margin: 0 0 8pt;
            }

            .page {
                width: 100%;
            }

            .columns {
                width: 100%;
                border-collapse: separate;
                border-spacing: 18pt 0;
                table-layout: fixed;
            }

            .columns td {
                vertical-align: top;
            }

            .schedule-grid th.pos,
            .schedule-grid td.pos {
                text-align: center;
            }

            .schedule-grid td.break-skip {
                text-align: center;
            }

            .col-left {
                width: 68%;
            }

            .col-right {
                width: 32%;
            }

            .panel {
                page-break-inside: avoid;
                break-inside: avoid;
                margin-bottom: 14pt;
            }

            .panel-title {
                font-size: 11pt;
                font-weight: 600;
                margin: 0 0 4pt;
            }

            .grid {
                width: 100%;
                border-collapse: collapse;
            }

            .grid th,
            .grid td {
                border: 0.75pt solid #000;
                padding: 2pt 4pt;
                text-align: left;
                vertical-align: top;
                word-wrap: break-word;
            }

            .chore-grid .chore-name {
                font-weight: 600;
                color: #111;
            }

            .chore-grid .chore-assignee {
                font-size: 8pt;
                color: #374151;
                margin-top: 2pt;
            }

            .chore-badges {
                display: flex;
                flex-wrap: wrap;
                gap: 2pt;
            }

            .chore-badge {
                background: #e0f2fe;
                border: 0.5pt solid #93c5fd;
                border-radius: 999px;
                color: #1d4ed8;
                font-size: 7pt;
                padding: 1pt 4pt;
                text-transform: uppercase;
                letter-spacing: 0.04em;
            }

            .schedule-grid th,
            .schedule-grid td {
                padding: 4pt 6pt;
            }

            .grid th {
                background: #f2f2f2;
                font-weight: 600;
            }

            .grid td.center {
                text-align: center;
            }

            .schedule-grid td:nth-child(2),
            .schedule-grid td:nth-child(3),
            .schedule-grid td:nth-child(4),
            .schedule-grid td:nth-child(5),
            .schedule-grid td:nth-child(6) {
                text-align: center;
                white-space: nowrap;
            }

            .schedule-grid td.chores {
                font-size: 8pt;
                line-height: 1.35;
            }

            .striped tbody tr:nth-child(even) td {
                background: #fafafa;
            }

            .ampm {
                font-size: 7pt;
                text-transform: lowercase;
            }

            .columns td > .panel:last-child {
                margin-bottom: 0;
            }
        </style>
    </head>
    <body>
    <div class="page">
        <h1>Staff Schedule — <?= h($displayDate); ?></h1>
        <table class="columns">
            <tr>
                <td class="col-left">
                    <div class="panel">
                        <div class="panel-title">Schedule</div>
                        <table class="grid striped schedule-grid">
                            <colgroup>
                                <col style="width:24%">
                                <col style="width:16%">
                                <col style="width:8%">
                                <col style="width:12%">
                                <col style="width:12%">
                                <col style="width:12%">
                                <col style="width:16%">
                            </colgroup>
                            <thead>
                            <tr>
                                <th>Employee</th>
                                <th>Shift</th>
                                <th class="pos">POS #</th>
                                <th>Break 1</th>
                                <th>Lunch</th>
                                <th>Break 2</th>
                                <th>Chores</th>
                            </tr>
                            </thead>
                            <tbody>
                            <?php for ($i = 0; $i < $scheduleRowCount; $i++):
                                $employee   = $employees[$i] ?? null;
                                $breaks     = is_array($employee['breaks'] ?? null) ? $employee['breaks'] : [];
                                $breakOne   = $breaks[0] ?? ['start' => '', 'duration' => ''];
                                $lunchBreak = $breaks[1] ?? ['start' => '', 'duration' => ''];
                                $breakTwo   = $breaks[2] ?? ['start' => '', 'duration' => ''];
                                $tasksHtml  = $employee ? renderTaskListHtml($employee['tasks'] ?? []) : '';
                                $breakOneDisplay =
                                    $employee && is_array($breakOne)
                                        ? buildBreakDisplayValue($breakOne, $employee, 'break1')
                                        : '';
                                $lunchDisplay =
                                    $employee && is_array($lunchBreak)
                                        ? buildBreakDisplayValue($lunchBreak, $employee, 'lunch')
                                        : '';
                                $breakTwoDisplay =
                                    $employee && is_array($breakTwo)
                                        ? buildBreakDisplayValue($breakTwo, $employee, 'break2')
                                        : '';
                                ?>
                                <?php
                                $breakOneCell = ['class' => 'break-cell', 'value' => ''];
                                $lunchCell    = ['class' => 'break-cell', 'value' => ''];
                                $breakTwoCell = ['class' => 'break-cell', 'value' => ''];

                                if ($employee) {
                                    if ($breakOneDisplay === 'X') {
                                        $breakOneCell['class'] .= ' break-skip';
                                        $breakOneCell['value'] = 'X';
                                    } else {
                                        $breakOneCell['value'] = formatTime($breakOneDisplay);
                                    }

                                    if ($lunchDisplay === 'X') {
                                        $lunchCell['class'] .= ' break-skip';
                                        $lunchCell['value'] = 'X';
                                    } else {
                                        $lunchCell['value'] = formatTime($lunchDisplay);
                                    }

                                    if ($breakTwoDisplay === 'X') {
                                        $breakTwoCell['class'] .= ' break-skip';
                                        $breakTwoCell['value'] = 'X';
                                    } else {
                                        $breakTwoCell['value'] = formatTime($breakTwoDisplay);
                                    }
                                }
                                ?>
                                <tr>
                                    <td><?= $employee ? h($employee['name'] ?? '') : ''; ?></td>
                                    <td><?= $employee ? formatTime((string) ($employee['shift'] ?? '')) : ''; ?></td>
                                    <td class="pos"><?= $employee ? h((string) ($employee['pos'] ?? '')) : ''; ?></td>
                                    <td class="<?= $breakOneCell['class']; ?>"><?= $breakOneCell['value']; ?></td>
                                    <td class="<?= $lunchCell['class']; ?>"><?= $lunchCell['value']; ?></td>
                                    <td class="<?= $breakTwoCell['class']; ?>"><?= $breakTwoCell['value']; ?></td>
                                <td class="chores"><?= $tasksHtml; ?></td>
                                </tr>
                            <?php endfor; ?>
                            </tbody>
                        </table>
                    </div>
                </td>
                <td class="col-right">
                    <div class="panel">
                        <div class="panel-title">Tip Tracker</div>
                        <table class="grid">
                            <colgroup>
                                <col style="width:25%">
                                <col style="width:25%">
                                <col style="width:25%">
                                <col style="width:25%">
                            </colgroup>
                            <thead>
                            <tr>
                                <th>Bag#</th>
                                <th>Amt</th>
                                <th>Init</th>
                                <th>Time</th>
                            </tr>
                            </thead>
                            <tbody>
                            <?php for ($i = 0; $i < $tipRowCount; $i++):
                                [$bag, $amount, $initials, $time] = normalizeTipEntry($tipEntries[$i] ?? []);
                                ?>
                                <tr>
                                    <td class="center"><?= $bag !== '' ? h($bag) : ''; ?></td>
                                    <td class="center"><?= $amount !== '' ? h($amount) : ''; ?></td>
                                    <td class="center"><?= $initials !== '' ? h($initials) : ''; ?></td>
                                    <td class="center"><?= $time !== '' ? formatTime($time) : ''; ?></td>
                                </tr>
                            <?php endfor; ?>
                            </tbody>
                        </table>
                    </div>
                    <div class="panel">
                        <div class="panel-title">Training</div>
                        <table class="grid">
                            <colgroup>
                                <col style="width:34%">
                                <col style="width:33%">
                                <col style="width:33%">
                            </colgroup>
                            <thead>
                            <tr>
                                <th>Trainee</th>
                                <th>Trainer</th>
                                <th>Topic</th>
                            </tr>
                            </thead>
                            <tbody>
                            <?php for ($i = 0; $i < $trainingRowCount; $i++):
                                $training = $trainingEntries[$i] ?? null;
                                $trainee  = $training && is_array($training) ? pickStringValue($training, ['trainee', 'employee', 'name']) : '';
                                $trainer  = $training && is_array($training) ? pickStringValue($training, ['trainer', 'supervisor']) : '';
                                $topic    = $training && is_array($training) ? pickStringValue($training, ['topic', 'subject']) : '';
                                ?>
                                <tr>
                                    <td><?= $trainee !== '' ? h($trainee) : ''; ?></td>
                                    <td><?= $trainer !== '' ? h($trainer) : ''; ?></td>
                                    <td><?= $topic !== '' ? h($topic) : ''; ?></td>
                                </tr>
                            <?php endfor; ?>
                            </tbody>
                        </table>
                    </div>
                    <?php if ($sortedChores !== []): ?>
                    <div class="panel">
                        <div class="panel-title">Chore Templates</div>
                        <table class="grid chore-grid">
                            <colgroup>
                                <col style="width:55%">
                                <col style="width:45%">
                            </colgroup>
                            <thead>
                            <tr>
                                <th>Chore</th>
                                <th>Metadata</th>
                            </tr>
                            </thead>
                            <tbody>
                            <?php foreach ($sortedChores as $chore):
                                $label = print_schedule_chore_name($chore);
                                $assignee = print_schedule_chore_assignee($chore, $employeeNames);
                                $badges = print_schedule_collect_chore_badges($chore, $choreDayNames);
                                ?>
                            <tr>
                                <td>
                                    <div class="chore-name"><?= h($label); ?></div>
                                    <?php if ($assignee !== ''): ?>
                                        <div class="chore-assignee">Assigned: <?= h($assignee); ?></div>
                                    <?php endif; ?>
                                </td>
                                <td>
                                    <?php if ($badges !== []): ?>
                                        <div class="chore-badges">
                                            <?php foreach ($badges as $badge): ?>
                                                <span class="chore-badge"><?= h($badge); ?></span>
                                            <?php endforeach; ?>
                                        </div>
                                    <?php endif; ?>
                                </td>
                            </tr>
                            <?php endforeach; ?>
                            </tbody>
                        </table>
                    </div>
                    <?php endif; ?>
                </td>
            </tr>
        </table>
    </div>
    </body>
    </html>
    <?php

    return (string) ob_get_clean();
}
