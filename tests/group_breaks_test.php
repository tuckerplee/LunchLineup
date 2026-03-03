<?php
require __DIR__ . '/../src/breaks.php';

function assert_close(float $a, float $b, string $msg): void
{
    if (abs($a - $b) > 1e-6) {
        echo $msg . "\n";
        exit(1);
    }
}

$policy = [
    'break1Offset' => 2,
    'lunchOffset' => 4,
    'break2Offset' => 2,
    'break1Duration' => 10,
    'lunchDuration' => 60,
    'break2Duration' => 10,
];

$employees = [
    ['start' => 10, 'end' => 19],
    ['start' => 11, 'end' => 19],
];

$result = schedule_group_breaks($employees, $policy);
assert_close($result[0]['break1'], 12, 'Employee1 break1');
assert_close($result[1]['break1'], 13, 'Employee2 break1');
assert_close($result[0]['lunch'], 14, 'Employee1 lunch');
assert_close($result[1]['lunch'], 15, 'Employee2 lunch');
assert_close($result[0]['break2'], 17, 'Employee1 break2');
assert_close($result[1]['break2'], 17 + 10 / 60, 'Employee2 break2');

$employees = [
    ['start' => 10, 'lunchDuration' => 30 / 60],
    ['start' => 11, 'lunchDuration' => 60 / 60],
];

$result = schedule_group_breaks($employees, $policy);
assert_close($result[0]['lunch'], 14, 'Employee1 lunch 30m');
assert_close($result[1]['lunch'], 15, 'Employee2 lunch 60m');
assert_close($result[0]['break2'], 16.5, 'Employee1 break2 after 30m lunch');
assert_close($result[1]['break2'], 16 + 40 / 60, 'Employee2 break2 after 60m lunch');

$employees = [
    ['start' => 10, 'end' => 19],
    ['start' => 11, 'end' => 20],
    ['start' => 12, 'end' => 20],
    ['start' => 12, 'end' => 20],
];

$result = schedule_group_breaks($employees, $policy);

$durations = [
    'break1' => 10 / 60,
    'lunch' => 60 / 60,
    'break2' => 10 / 60,
];

foreach (['break1', 'lunch', 'break2'] as $type) {
    for ($t = 0; $t < 24; $t += 1 / 12) {
        $active = 0;
        foreach ($result as $emp) {
            $s = $emp[$type];
            $e = $emp[$type] + $durations[$type];
            if ($t >= $s && $t < $e) {
                $active++;
            }
        }
        if ($type === 'lunch' && $active > 2) {
            echo "Too many lunches\n";
            exit(1);
        }
        if ($type !== 'lunch' && $active > 1) {
            echo "Too many breaks\n";
            exit(1);
        }
    }
}

echo "OK\n";
