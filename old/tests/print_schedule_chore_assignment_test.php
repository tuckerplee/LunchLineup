<?php

declare(strict_types=1);

$_testChores = [];
$_testStaff  = [];

function fetchChores(int $storeId): array
{
    global $_testChores;
    return $_testChores[$storeId] ?? [];
}

function fetchStaff(int $storeId): array
{
    global $_testStaff;
    return $_testStaff[$storeId] ?? [];
}

if (!function_exists('sanitizeString')) {
    function sanitizeString(string $value): string
    {
        return $value;
    }
}

require __DIR__ . '/../src/print_schedule.php';

function assertSameValue($expected, $actual, string $message = ''): void
{
    if ($expected !== $actual) {
        fwrite(STDERR, "Assertion failed: {$message}\n");
        fwrite(STDERR, "Expected: " . var_export($expected, true) . "\n");
        fwrite(STDERR, "Actual:   " . var_export($actual, true) . "\n");
        exit(1);
    }
}

$storeId = 1;
$date    = '2024-05-12';

// loadChores filters
$_testChores = [
    $storeId => [
        [
            'id' => 1,
            'description' => 'High Priority Task',
            'isActive' => true,
            'autoAssignEnabled' => true,
            'priority' => 10,
            'frequency' => 'daily',
            'recurrenceInterval' => 1,
            'showOnDays' => [0, 1, 2, 3, 4, 5, 6],
        ],
        [
            'id' => 2,
            'description' => 'Inactive Task',
            'isActive' => false,
            'autoAssignEnabled' => true,
        ],
        [
            'id' => 3,
            'description' => 'Auto Off Task',
            'isActive' => true,
            'autoAssignEnabled' => false,
        ],
        [
            'id' => 4,
            'description' => 'Past Window Task',
            'isActive' => true,
            'autoAssignEnabled' => true,
            'windowStart' => '2024-05-01',
            'windowEnd' => '2024-05-10',
        ],
        [
            'id' => 5,
            'description' => 'Weekly Task',
            'isActive' => true,
            'autoAssignEnabled' => true,
            'frequency' => 'weekly',
            'recurrenceInterval' => 2,
            'showOnDays' => [0],
        ],
        [
            'id' => 6,
            'description' => 'Window Task',
            'isActive' => true,
            'autoAssignEnabled' => true,
            'windowStart' => '2024-05-10',
            'windowEnd' => '2024-05-12 23:00:00',
        ],
        [
            'id' => 7,
            'description' => 'Wrong Day Task',
            'isActive' => true,
            'autoAssignEnabled' => true,
            'showOnDays' => [1],
        ],
    ],
];

$filtered = loadChores($date, $storeId);
$filteredNames = array_map(
    static fn (array $chore): string => $chore['description'] ?? '',
    $filtered
);
sort($filteredNames);
assertSameValue(
    ['High Priority Task', 'Weekly Task', 'Window Task'],
    $filteredNames,
    'loadChores should keep only eligible templates'
);

// assignment behaviours
$_testChores[$storeId] = [
    [
        'id' => 10,
        'description' => 'High Priority Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 10,
        'excludeCloser' => true,
    ],
    [
        'id' => 11,
        'description' => 'Headcount Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 7,
        'minStaffLevel' => 2,
    ],
    [
        'id' => 12,
        'description' => 'Opt-Out Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 8,
    ],
    [
        'id' => 13,
        'description' => 'Capped Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 6,
        'allowMultipleAssignees' => true,
        'maxPerDay' => 1,
        'maxPerEmployeePerDay' => 1,
    ],
    [
        'id' => 14,
        'description' => 'Opener Blocked Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 5,
        'excludeOpener' => true,
    ],
    [
        'id' => 15,
        'description' => 'Position Opener Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 4,
        'excludeOpener' => true,
    ],
    [
        'id' => 18,
        'description' => 'Single Assignee Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 3,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 1,
        'tasks' => ['High Priority Task'],
        'pos' => ['register'],
        'metadata' => ['skills' => ['greeting'], 'isOpener' => true],
    ],
    [
        'id' => 2,
        'tasks' => ['Opt-Out Task'],
        'pos' => ['register'],
        'metadata' => ['skills' => ['greeting'], 'autoAssignOptOut' => true, 'isCloser' => true],
    ],
    [
        'id' => 3,
        'tasks' => ['Headcount Task'],
        'pos' => ['kitchen'],
        'metadata' => ['skills' => ['cooking']],
    ],
    [
        'id' => 4,
        'tasks' => [],
        'pos' => ['Opener'],
    ],
];

$schedule = [
    'employees' => [
        [
            'id' => 1,
            'name' => 'Alice',
            'pos' => 'Register',
            'tasks' => [
                ['description' => 'Capped Task', 'type' => 'chore'],
            ],
        ],
        [
            'id' => 2,
            'name' => 'Bob',
            'pos' => 'Closer',
            'metadata' => ['isCloser' => true],
            'tasks' => ['Single Assignee Task'],
        ],
        [
            'id' => 3,
            'name' => 'Cara',
            'pos' => 'Kitchen',
            'metadata' => ['skills' => ['cooking']],
            'tasks' => [],
        ],
        [
            'id' => 4,
            'name' => 'Drew',
            'pos' => 'Opener',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($schedule, $storeId, $date);

$aliceTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $schedule['employees'][0]['tasks']
);
$bobTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $schedule['employees'][1]['tasks']
);
$caraTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $schedule['employees'][2]['tasks']
);
$drewTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $schedule['employees'][3]['tasks']
);

assertSameValue(
    true,
    in_array('High Priority Task', $aliceTasks, true),
    'High priority chore should go to Alice'
);

assertSameValue(
    false,
    in_array('High Priority Task', $bobTasks, true),
    'Closer should not receive excluded chore'
);

assertSameValue(
    false,
    in_array('Opener Blocked Task', $aliceTasks, true),
    'Opener should not receive excluded chore'
);

assertSameValue(
    true,
    in_array('Opener Blocked Task', $caraTasks, true),
    'Non-opener should receive opener-excluded chore'
);

assertSameValue(
    false,
    in_array('Position Opener Task', $drewTasks, true),
    'Opener identified from capitalized position should be excluded'
);

assertSameValue(
    true,
    in_array('Position Opener Task', $caraTasks, true) || in_array('Position Opener Task', $aliceTasks, true),
    'Position-based opener exclusion should still allow assignment to eligible staff'
);

assertSameValue(
    true,
    in_array('Headcount Task', $caraTasks, true),
    'Headcount-gated chore should assign when enough staff are available'
);

assertSameValue(
    false,
    in_array('Opt-Out Task', $bobTasks, true),
    'Opted-out employee should not receive chore'
);

assertSameValue(
    true,
    in_array('Opt-Out Task', $caraTasks, true) || in_array('Opt-Out Task', $aliceTasks, true),
    'Opt-out chore should still be assigned to an eligible employee'
);

assertSameValue(
    false,
    in_array('Capped Task', $aliceTasks, true) && count(array_keys($aliceTasks, 'Capped Task', true)) > 1,
    'Capped chore should respect per-employee limits'
);

assertSameValue(
    0,
    count(array_keys($bobTasks, 'Opt-Out Task', true)),
    'Opted-out employee should remain unassigned for the opt-out chore'
);

assertSameValue(
    0,
    count(array_keys($aliceTasks, 'Capped Task', true)) - 1,
    'Existing capped chore assignment should block new ones'
);

assertSameValue(
    true,
    !in_array('Capped Task', $caraTasks, true) && !in_array('Capped Task', $bobTasks, true),
    'Max per day should prevent new capped assignments'
);

$singleAssigneeTotals = count(array_keys($aliceTasks, 'Single Assignee Task', true))
    + count(array_keys($bobTasks, 'Single Assignee Task', true))
    + count(array_keys($caraTasks, 'Single Assignee Task', true))
    + count(array_keys($drewTasks, 'Single Assignee Task', true));

assertSameValue(
    1,
    $singleAssigneeTotals,
    'Single-assignee chore should not receive additional assignments'
);

assertSameValue(
    1,
    count(array_keys($bobTasks, 'Single Assignee Task', true)),
    'Existing single-assignee chore should remain assigned to its original employee'
);

$_testChores[$storeId] = [
    [
        'id' => 16,
        'description' => 'Shift Opener Exclusion',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'excludeOpener' => true,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 21,
        'tasks' => [],
    ],
    [
        'id' => 22,
        'tasks' => [],
    ],
];

$shiftSchedule = [
    'employees' => [
        [
            'id' => 21,
            'name' => 'Gina',
            'shift' => '9:00 AM-5:00 PM',
            'tasks' => [],
        ],
        [
            'id' => 22,
            'name' => 'Hank',
            'shift' => '1:00 PM-9:00 PM',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($shiftSchedule, $storeId, $date);

$ginaTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $shiftSchedule['employees'][0]['tasks']
);
$hankTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $shiftSchedule['employees'][1]['tasks']
);

assertSameValue(
    false,
    in_array('Shift Opener Exclusion', $ginaTasks, true),
    'Earliest shift should count as an opener when exclusions apply'
);

assertSameValue(
    true,
    in_array('Shift Opener Exclusion', $hankTasks, true),
    'Later shift should receive opener-excluded chores when eligible staff exist'
);

$_testStaff[$storeId] = [
    [
        'id' => 23,
        'tasks' => [],
    ],
];

$singleOpenerSchedule = [
    'employees' => [
        [
            'id' => 23,
            'name' => 'Ivy',
            'shift' => '9:00 AM-5:00 PM',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($singleOpenerSchedule, $storeId, $date);

$singleOpenerTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $singleOpenerSchedule['employees'][0]['tasks']
);

assertSameValue(
    true,
    in_array('Shift Opener Exclusion', $singleOpenerTasks, true),
    'Opener-excluded chores should fall back to the only available employee when necessary'
);

$_testChores[$storeId] = [
    [
        'id' => 22,
        'description' => 'Shift Closer Exclusion',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'excludeCloser' => true,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 24,
        'tasks' => [],
    ],
];

$singleCloserSchedule = [
    'employees' => [
        [
            'id' => 24,
            'name' => 'Jules',
            'shift' => '1:00 PM-9:00 PM',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($singleCloserSchedule, $storeId, $date);

$singleCloserTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $singleCloserSchedule['employees'][0]['tasks']
);

assertSameValue(
    true,
    in_array('Shift Closer Exclusion', $singleCloserTasks, true),
    'Closer-excluded chores should fall back to the only available employee when necessary'
);

$_testChores[$storeId] = [
    [
        'id' => 23,
        'description' => 'Fallback Opener Task 1',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'excludeOpener' => true,
    ],
    [
        'id' => 24,
        'description' => 'Fallback Opener Task 2',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'excludeOpener' => true,
    ],
    [
        'id' => 25,
        'description' => 'Fallback Opener Task 3',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'excludeOpener' => true,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 40,
        'tasks' => [],
    ],
    [
        'id' => 41,
        'tasks' => [],
    ],
    [
        'id' => 42,
        'tasks' => [],
    ],
];

$multiOpenerSchedule = [
    'employees' => [
        [
            'id' => 40,
            'name' => 'Ann',
            'shift' => '8:00 AM-4:00 PM',
            'tasks' => [],
        ],
        [
            'id' => 41,
            'name' => 'Ben',
            'shift' => '8:15 AM-4:15 PM',
            'tasks' => [],
        ],
        [
            'id' => 42,
            'name' => 'Cia',
            'shift' => '8:30 AM-4:30 PM',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($multiOpenerSchedule, $storeId, $date);

$annTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $multiOpenerSchedule['employees'][0]['tasks']
);
$benTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $multiOpenerSchedule['employees'][1]['tasks']
);
$ciaTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $multiOpenerSchedule['employees'][2]['tasks']
);

assertSameValue(
    [],
    $annTasks,
    'Fallback should not relax exclusions when more than one opener is available'
);

assertSameValue(
    [],
    $benTasks,
    'Additional openers should remain excluded when base constraints fail'
);

assertSameValue(
    [],
    $ciaTasks,
    'Later openers should not receive opener-excluded chores when multiples are present'
);

$_testChores[$storeId] = [
    [
        'id' => 26,
        'description' => 'Repeat Coverage Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
    ],
    [
        'id' => 27,
        'description' => 'Repeat Coverage Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 50,
        'tasks' => [],
    ],
    [
        'id' => 51,
        'tasks' => [],
    ],
    [
        'id' => 52,
        'tasks' => [],
    ],
];

$repeatSchedule = [
    'employees' => [
        [
            'id' => 50,
            'name' => 'Rin',
            'tasks' => [],
        ],
        [
            'id' => 51,
            'name' => 'Sky',
            'tasks' => [],
        ],
        [
            'id' => 52,
            'name' => 'Tao',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($repeatSchedule, $storeId, $date);

$repeatAssignments = array_map(
    static fn ($employee) => array_map(
        static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
        $employee['tasks']
    ),
    $repeatSchedule['employees']
);

$repeatTotals = array_sum(
    array_map(
        static fn (array $tasks) => count(array_keys($tasks, 'Repeat Coverage Task', true)),
        $repeatAssignments
    )
);

assertSameValue(
    2,
    $repeatTotals,
    'Chores sharing a description should both be assigned'
);

$repeatAssigneeCount = count(
    array_filter(
        $repeatAssignments,
        static fn (array $tasks) => in_array('Repeat Coverage Task', $tasks, true)
    )
);

assertSameValue(
    2,
    $repeatAssigneeCount,
    'Repeat chores should distribute across multiple employees when available'
);

$_testChores[$storeId] = [
    [
        'id' => 20,
        'description' => 'Minimum Headcount Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 3,
        'minStaffLevel' => 2,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 10,
        'tasks' => [],
    ],
    [
        'id' => 11,
        'tasks' => [],
        'metadata' => [],
    ],
];

$twoPersonSchedule = [
    'employees' => [
        [
            'id' => 10,
            'name' => 'Eve',
            'tasks' => [],
        ],
        [
            'id' => 11,
            'name' => 'Frank',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($twoPersonSchedule, $storeId, $date);

$twoPersonTasks = array_merge(
    array_map(
        static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
        $twoPersonSchedule['employees'][0]['tasks']
    ),
    array_map(
        static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
        $twoPersonSchedule['employees'][1]['tasks']
    )
);

assertSameValue(
    true,
    in_array('Minimum Headcount Task', $twoPersonTasks, true),
    'Chore with a headcount requirement should assign when enough staff are scheduled'
);

$_testStaff[$storeId] = [
    [
        'id' => 11,
        'tasks' => [],
        'metadata' => [],
    ],
];

$soloSchedule = [
    'employees' => [
        [
            'id' => 11,
            'name' => 'Frank',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($soloSchedule, $storeId, $date);

$soloTasks = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $soloSchedule['employees'][0]['tasks']
);

assertSameValue(
    false,
    in_array('Minimum Headcount Task', $soloTasks, true),
    'Headcount-gated chores should remain unassigned if staffing is below the requirement'
);

$_testChores[$storeId] = [
    [
        'id' => 21,
        'description' => 'Dynamic Shift Task',
        'isActive' => true,
        'autoAssignEnabled' => true,
        'priority' => 9,
        'excludeOpener' => true,
    ],
];

$_testStaff[$storeId] = [
    [
        'id' => 30,
        'tasks' => ['Manual Task'],
    ],
    [
        'id' => 31,
        'tasks' => [],
    ],
];

$rerunSchedule = [
    'employees' => [
        [
            'id' => 30,
            'name' => 'Sam',
            'shift' => '3:00 PM-9:00 PM',
            'tasks' => ['Manual Task'],
        ],
        [
            'id' => 31,
            'name' => 'Terry',
            'shift' => '12:00 PM-8:00 PM',
            'tasks' => [],
        ],
    ],
];

assignChoresToSchedule($rerunSchedule, $storeId, $date);

$samTasks = $rerunSchedule['employees'][0]['tasks'];
$terryTasks = $rerunSchedule['employees'][1]['tasks'];

$samDescriptions = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $samTasks
);
$terryDescriptions = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $terryTasks
);

assertSameValue(
    true,
    in_array('Dynamic Shift Task', $samDescriptions, true),
    'Initial auto-assignment should target the first eligible employee'
);

assertSameValue(
    false,
    in_array('Dynamic Shift Task', $terryDescriptions, true),
    'Initial pass should not assign the chore to the second employee'
);

$autoAssignedFlags = array_values(array_filter(
    $samTasks,
    static fn ($task) => is_array($task) && ($task['autoAssigned'] ?? false)
));

assertSameValue(
    true,
    $autoAssignedFlags !== [],
    'Auto-assigned chores should be tagged so they can be cleaned up on reruns'
);

$rerunSchedule['employees'][0]['shift'] = 'Open 9:00 AM-5:00 PM';

assignChoresToSchedule($rerunSchedule, $storeId, $date);

$samDescriptionsAfter = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $rerunSchedule['employees'][0]['tasks']
);
$terryDescriptionsAfter = array_map(
    static fn ($task) => is_array($task) ? ($task['description'] ?? '') : $task,
    $rerunSchedule['employees'][1]['tasks']
);

assertSameValue(
    true,
    in_array('Manual Task', $samDescriptionsAfter, true),
    'Manual tasks should persist after cleaning auto-assigned chores'
);

assertSameValue(
    false,
    in_array('Dynamic Shift Task', $samDescriptionsAfter, true),
    'Auto-assigned chores should be removed when the employee becomes ineligible'
);

assertSameValue(
    true,
    in_array('Dynamic Shift Task', $terryDescriptionsAfter, true),
    'Auto-assigned chores should move to the newly eligible employee after rerun'
);

$samAutoAssignedAfter = array_values(array_filter(
    $rerunSchedule['employees'][0]['tasks'],
    static fn ($task) => is_array($task) && ($task['autoAssigned'] ?? false)
));

assertSameValue(
    true,
    $samAutoAssignedAfter === [],
    'Sam should no longer have auto-assigned chores after the rerun'
);

$terryAutoAssignedAfter = array_values(array_filter(
    $rerunSchedule['employees'][1]['tasks'],
    static fn ($task) => is_array($task) && ($task['autoAssigned'] ?? false)
));

assertSameValue(
    true,
    $terryAutoAssignedAfter !== [],
    'Terry should now have a flagged auto-assigned chore after the rerun'
);

fwrite(STDOUT, "print schedule chore assignment tests passed\n");
