<?php
declare(strict_types=1);

function breaksOverlap(float $start1, float $end1, float $start2, float $end2): bool
{
    return $start1 < $end2 && $start2 < $end1;
}

function avoid_break_conflicts(array $breakTimes, array $otherBreaks, float $shiftStart, float $shiftEnd, array $policy): array
{
    $break1Duration = ($policy['break1Duration'] ?? 10) / 60;
    $lunchDuration = $breakTimes['lunchDuration'] ?? ($policy['lunchDuration'] ?? 30) / 60;
    $break2Duration = ($policy['break2Duration'] ?? 10) / 60;
    $maxConcurrent = $policy['maxConcurrent'] ?? 1;

    $hasConflict = function (float $s, float $e) use ($otherBreaks, $break1Duration, $lunchDuration, $break2Duration, $policy) {
        $count = 0;
        foreach ($otherBreaks as $other) {
            $otherLunchDur = $other['lunchDuration'] ?? ($policy['lunchDuration'] ?? 30) / 60;
            if (
                breaksOverlap($s, $e, $other['break1'], $other['break1'] + $break1Duration) ||
                breaksOverlap($s, $e, $other['lunch'], $other['lunch'] + $otherLunchDur) ||
                breaksOverlap($s, $e, $other['break2'], $other['break2'] + $break2Duration)
            ) {
                $count++;
            }
        }
        return $count;
    };

    $findNonConflict = function (float $ideal, float $duration, float $min, float $max) use ($hasConflict, $maxConcurrent) {
        $clamped = min(max($ideal, $min), $max - $duration);
        if ($hasConflict($clamped, $clamped + $duration) < $maxConcurrent) {
            return $clamped;
        }
        $step = 0.25;
        $before = $clamped - $step;
        $after = $clamped + $step;
        while ($before >= $min || $after <= $max - $duration) {
            if ($before >= $min && $hasConflict($before, $before + $duration) < $maxConcurrent) {
                return $before;
            }
            if ($after <= $max - $duration && $hasConflict($after, $after + $duration) < $maxConcurrent) {
                return $after;
            }
            $before -= $step;
            $after += $step;
        }
        return $clamped;
    };

    $shiftDuration = $shiftEnd > $shiftStart ? $shiftEnd - $shiftStart : $shiftEnd + 24 - $shiftStart;

    $break1Min = $shiftStart + 1;
    $break1Max = $shiftStart + $shiftDuration / 3;
    $lunchMin = $shiftStart + $shiftDuration / 3;
    $lunchMax = $shiftStart + 2 * $shiftDuration / 3;
    $break2Min = $shiftStart + 2 * $shiftDuration / 3;
    $break2Max = $shiftEnd - 1;

    $breakTimes['break1'] = $findNonConflict($breakTimes['break1'], $break1Duration, $break1Min, $break1Max);
    $breakTimes['lunch'] = $findNonConflict($breakTimes['lunch'], $lunchDuration, $lunchMin, $lunchMax);
    $breakTimes['break2'] = $findNonConflict($breakTimes['break2'], $break2Duration, $break2Min, $break2Max);
    $breakTimes['lunchDuration'] = $lunchDuration;

    return $breakTimes;
}

function calculateBreaks(float $start, float $end, array $policy, array $otherBreaks = []): array
{
    $shiftDuration = $end - $start;
    if ($shiftDuration < 0) {
        $shiftDuration += 24;
    }
    $break1 = $start + $shiftDuration * ($policy['break1Percent'] ?? 0.25);
    $lunch = $start + $shiftDuration * ($policy['lunchPercent'] ?? 0.5);
    $break2 = $start + $shiftDuration * ($policy['break2Percent'] ?? 0.75);

    $break1 = fmod($break1 + 24, 24);
    $lunch = fmod($lunch + 24, 24);
    $break2 = fmod($break2 + 24, 24);

    $times = [
        'break1' => $break1,
        'lunch' => $lunch,
        'break2' => $break2,
    ];

    return avoid_break_conflicts($times, $otherBreaks, $start, $end, $policy);
}

function round_to_five(float $time): float
{
    return round($time * 12) / 12;
}

function scheduleEvent(float $ideal, float $duration, array &$events, int $maxConcurrent): float
{
    $time = $ideal;
    $step = 5 / 60;
    while (true) {
        $conflicts = 0;
        foreach ($events as $ev) {
            if (breaksOverlap($time, $time + $duration, $ev[0], $ev[1])) {
                $conflicts++;
            }
        }
        if ($conflicts < $maxConcurrent) {
            break;
        }
        $time += $step;
    }
    $time = round_to_five($time);
    $events[] = [$time, $time + $duration];
    return $time;
}

function schedule_group_breaks(array $employees, array $policy): array
{
    $break1Offset = $policy['break1Offset'] ?? 2;
    $lunchOffset = $policy['lunchOffset'] ?? 4;
    $break2Offset = $policy['break2Offset'] ?? 2;

    $break1Duration = ($policy['break1Duration'] ?? 10) / 60;
    $break2Duration = ($policy['break2Duration'] ?? 10) / 60;

    foreach ($employees as &$emp) {
        $emp['lunchDuration'] = $emp['lunchDuration'] ?? ($policy['lunchDuration'] ?? 60) / 60;
    }
    unset($emp);

    usort($employees, fn($a, $b) => $a['start'] <=> $b['start']);
    $count = count($employees);

    if ($count === 2) {
        $e1 = &$employees[0];
        $e2 = &$employees[1];

        $e1['break1'] = round_to_five($e1['start'] + $break1Offset);
        $e1End1 = $e1['break1'] + $break1Duration;
        $e2['break1'] = round_to_five(max($e2['start'] + $break1Offset, $e1End1));
        $e2End1 = $e2['break1'] + $break1Duration;

        $e1['lunch'] = round_to_five($e1['start'] + $lunchOffset);
        $e1EndL = $e1['lunch'] + $e1['lunchDuration'];
        $e2['lunch'] = round_to_five(max($e2['start'] + $lunchOffset, $e1EndL));
        $e2EndL = $e2['lunch'] + $e2['lunchDuration'];

        $e1['break2'] = round_to_five($e1EndL + $break2Offset);
        $e1End2 = $e1['break2'] + $break2Duration;
        $e2['break2'] = round_to_five(max($e1End2, $e2EndL));

        return $employees;
    }

    $maxBreaks = $count > 4 ? 2 : 1;
    $maxLunches = $count >= 4 ? 2 : 1;

    $breakEvents1 = [];
    $lunchEvents = [];
    $breakEvents2 = [];

    foreach ($employees as &$emp) {
        $b1Ideal = round_to_five($emp['start'] + $break1Offset);
        $emp['break1'] = scheduleEvent($b1Ideal, $break1Duration, $breakEvents1, $maxBreaks);

        $lunchIdeal = round_to_five($emp['start'] + $lunchOffset);
        $emp['lunch'] = scheduleEvent($lunchIdeal, $emp['lunchDuration'], $lunchEvents, $maxLunches);

        $b2Ideal = round_to_five($emp['lunch'] + $emp['lunchDuration'] + $break2Offset);
        $emp['break2'] = scheduleEvent($b2Ideal, $break2Duration, $breakEvents2, $maxBreaks);
    }
    unset($emp);

    return $employees;
}
