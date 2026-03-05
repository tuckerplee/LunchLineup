<?php
declare(strict_types=1);

function fetchChores(int $storeId): array
{
    $db = getDb();
    $stmt = $db->prepare('SELECT * FROM chores WHERE store_id = ?');
    $stmt->execute([$storeId]);
    $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
    if (!$rows) {
        return [];
    }

    usort(
        $rows,
        static function (array $a, array $b): int {
            $priorityA = (int) ($a['priority'] ?? 0);
            $priorityB = (int) ($b['priority'] ?? 0);
            if ($priorityA !== $priorityB) {
                return $priorityB <=> $priorityA;
            }

            $nameA = strtolower(trim((string) ($a['name'] ?? $a['description'] ?? $a['title'] ?? '')));
            $nameB = strtolower(trim((string) ($b['name'] ?? $b['description'] ?? $b['title'] ?? '')));
            if ($nameA !== $nameB) {
                return $nameA <=> $nameB;
            }

            $idA = (int) ($a['id'] ?? 0);
            $idB = (int) ($b['id'] ?? 0);

            return $idA <=> $idB;
        }
    );

    $result = [];
    foreach ($rows as $row) {
        $id = (int) ($row['id'] ?? 0);
        $activeDays = [];
        if (!empty($row['active_days'])) {
            $activeDays = array_values(
                array_filter(
                    array_map('trim', explode(',', (string) $row['active_days'])),
                    static fn ($day) => $day !== ''
                )
            );
        }
        $showOnDays = $activeDays === [] ? null : convertDaysToIndexes($activeDays);
        $nameValue = sanitizeString((string) ($row['name'] ?? $row['description'] ?? $row['title'] ?? ''));
        $instructionsValue = sanitizeString((string) ($row['instructions'] ?? $row['notes'] ?? ''));

        $result[] = [
            'id' => $id,
            'storeId' => (int) ($row['store_id'] ?? $storeId),
            'name' => $nameValue,
            'description' => $nameValue,
            'instructions' => $instructionsValue,
            'isActive' => (bool) ($row['is_active'] ?? false),
            'priority' => (int) ($row['priority'] ?? 0),
            'autoAssignEnabled' => (bool) ($row['auto_assign_enabled'] ?? true),
            'frequency' => $row['frequency'] ?? 'daily',
            'recurrenceInterval' => (int) ($row['recurrence_interval'] ?? 1),
            'activeDays' => $activeDays,
            'showOnDays' => $showOnDays,
            'windowStart' => $row['window_start'] ?? null,
            'windowEnd' => $row['window_end'] ?? null,
            'daypart' => $row['daypart'] ?? null,
            'excludeCloser' => (bool) ($row['exclude_closer'] ?? false),
            'excludeOpener' => (bool) ($row['exclude_opener'] ?? false),
            'leadTimeMinutes' => $row['lead_time_minutes'] !== null ? (int) $row['lead_time_minutes'] : null,
            'deadlineTime' => $row['deadline_time'] ?? null,
            'allowMultipleAssignees' => (bool) ($row['allow_multiple_assignees'] ?? false),
            'maxPerDay' => $row['max_per_day'] !== null ? (int) $row['max_per_day'] : null,
            'maxPerShift' => $row['max_per_shift'] !== null ? (int) $row['max_per_shift'] : null,
            'maxPerEmployeePerDay' => $row['max_per_employee_per_day'] !== null ? (int) $row['max_per_employee_per_day'] : null,
            'minStaffLevel' => $row['min_staff_level'] !== null ? (int) $row['min_staff_level'] : null,
            'estimatedDurationMinutes' => $row['estimated_duration_minutes'] !== null ? (int) $row['estimated_duration_minutes'] : null,
            'assignedTo' => $row['assigned_to'] !== null ? (int) $row['assigned_to'] : null,
            'createdBy' => isset($row['created_by']) ? (int) $row['created_by'] : null,
            'createdAt' => $row['created_at'] ?? null,
            'updatedAt' => $row['updated_at'] ?? null,
        ];
    }

    return $result;
}

function saveChores(array $chores, ?int $defaultStoreId = null): void
{
    $db = getDb();
    $db->beginTransaction();

    try {
        $storeIds = [];
        foreach ($chores as $chore) {
            $sid = $chore['storeId'] ?? $chore['store_id'] ?? $defaultStoreId;
            if ($sid === null) {
                throw new InvalidArgumentException('Missing storeId in chore payload');
            }
            $storeIds[(int) $sid] = true;
        }
        if ($storeIds === [] && $defaultStoreId !== null) {
            $storeIds[$defaultStoreId] = true;
        }

        $existingIdsByStore = [];
        $existingStmt = $db->prepare('SELECT id FROM chores WHERE store_id = ?');
        foreach (array_keys($storeIds) as $sid) {
            $existingStmt->execute([$sid]);
            $existingIdsByStore[$sid] = array_map('intval', $existingStmt->fetchAll(PDO::FETCH_COLUMN));
        }

        $createdBy = isset($GLOBALS['audit_user_id']) && (int) $GLOBALS['audit_user_id'] > 0
            ? (int) $GLOBALS['audit_user_id']
            : null;

        $insertStmt = $db->prepare(
            'INSERT INTO chores (store_id, name, instructions, is_active, priority, auto_assign_enabled, '
            . 'frequency, recurrence_interval, active_days, window_start, window_end, daypart, '
            . 'exclude_closer, exclude_opener, lead_time_minutes, deadline_time, allow_multiple_assignees, max_per_day, max_per_shift, '
            . 'max_per_employee_per_day, min_staff_level, estimated_duration_minutes, created_by, assigned_to) '
            . 'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
        );
        $updateStmt = $db->prepare(
            'UPDATE chores SET name = ?, instructions = ?, is_active = ?, priority = ?, '
            . 'auto_assign_enabled = ?, frequency = ?, recurrence_interval = ?, active_days = ?, '
            . 'window_start = ?, window_end = ?, daypart = ?, exclude_closer = ?, exclude_opener = ?, lead_time_minutes = ?, deadline_time = ?, '
            . 'allow_multiple_assignees = ?, max_per_day = ?, max_per_shift = ?, max_per_employee_per_day = ?, min_staff_level = ?, '
            . 'estimated_duration_minutes = ?, assigned_to = ? WHERE id = ? AND store_id = ?'
        );
        $deleteStmt = $db->prepare('DELETE FROM chores WHERE id = ? AND store_id = ?');

        $processedIdsByStore = [];
        foreach ($chores as $chore) {
            $storeId = $chore['storeId'] ?? $chore['store_id'] ?? $defaultStoreId;
            if ($storeId === null) {
                throw new InvalidArgumentException('Missing storeId in chore payload');
            }
            $storeId = (int) $storeId;
            $normalized = prepareChoreRecord($chore, $storeId);
            $id = isset($chore['id']) && (int) $chore['id'] > 0 ? (int) $chore['id'] : null;

            if ($id !== null && in_array($id, $existingIdsByStore[$storeId] ?? [], true)) {
                $updateStmt->execute([
                    $normalized['name'],
                    $normalized['instructions'],
                    $normalized['is_active'],
                    $normalized['priority'],
                    $normalized['auto_assign_enabled'],
                    $normalized['frequency'],
                    $normalized['recurrence_interval'],
                    $normalized['active_days'],
                    $normalized['window_start'],
                    $normalized['window_end'],
                    $normalized['daypart'],
                    $normalized['exclude_closer'],
                    $normalized['exclude_opener'],
                    $normalized['lead_time_minutes'],
                    $normalized['deadline_time'],
                    $normalized['allow_multiple_assignees'],
                    $normalized['max_per_day'],
                    $normalized['max_per_shift'],
                    $normalized['max_per_employee_per_day'],
                    $normalized['min_staff_level'],
                    $normalized['estimated_duration_minutes'],
                    $normalized['assigned_to'],
                    $id,
                    $storeId,
                ]);
            } else {
                $insertStmt->execute([
                    $storeId,
                    $normalized['name'],
                    $normalized['instructions'],
                    $normalized['is_active'],
                    $normalized['priority'],
                    $normalized['auto_assign_enabled'],
                    $normalized['frequency'],
                    $normalized['recurrence_interval'],
                    $normalized['active_days'],
                    $normalized['window_start'],
                    $normalized['window_end'],
                    $normalized['daypart'],
                    $normalized['exclude_closer'],
                    $normalized['exclude_opener'],
                    $normalized['lead_time_minutes'],
                    $normalized['deadline_time'],
                    $normalized['allow_multiple_assignees'],
                    $normalized['max_per_day'],
                    $normalized['max_per_shift'],
                    $normalized['max_per_employee_per_day'],
                    $normalized['min_staff_level'],
                    $normalized['estimated_duration_minutes'],
                    $createdBy,
                    $normalized['assigned_to'],
                ]);
                $id = (int) $db->lastInsertId();
            }

            if (!isset($processedIdsByStore[$storeId])) {
                $processedIdsByStore[$storeId] = [];
            }
            $processedIdsByStore[$storeId][] = $id;
        }

        foreach ($existingIdsByStore as $sid => $existingIds) {
            $keep = $processedIdsByStore[$sid] ?? [];
            $toDelete = array_diff($existingIds, $keep);
            foreach ($toDelete as $removeId) {
                $deleteStmt->execute([(int) $removeId, $sid]);
            }
        }

        $db->commit();
    } catch (Throwable $e) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $e;
    }

    auditLog('save', 'chores');
}

/**
 * @param array<string, mixed> $chore
 * @return array<string, mixed>
 */
function prepareChoreRecord(array $chore, int $storeId): array
{
    $name = truncateString((string) ($chore['name'] ?? $chore['description'] ?? ''), 255);
    $instructions = trim((string) ($chore['instructions'] ?? ''));

    $frequency = normalizeChoreFrequency((string) ($chore['frequency'] ?? 'daily'));
    $recurrenceInterval = (int) max(1, (int) ($chore['recurrenceInterval'] ?? 1));
    $activeDays = normalizeActiveDays($chore['activeDays'] ?? $chore['showOnDays'] ?? []);
    $windowStart = normalizeTime($chore['windowStart'] ?? null);
    $windowEnd = normalizeTime($chore['windowEnd'] ?? null);
    $deadlineTime = normalizeTime($chore['deadlineTime'] ?? null);
    $daypart = normalizeDaypart($chore['daypart'] ?? null);

    return [
        'name' => $name,
        'instructions' => $instructions !== '' ? $instructions : null,
        'is_active' => !empty($chore['isActive']) ? 1 : 0,
        'priority' => (int) ($chore['priority'] ?? 0),
        'auto_assign_enabled' => (!array_key_exists('autoAssignEnabled', $chore)
            || !empty($chore['autoAssignEnabled'])
            || !empty($chore['autoAssign'])) ? 1 : 0,
        'frequency' => $frequency,
        'recurrence_interval' => $recurrenceInterval,
        'active_days' => $activeDays,
        'window_start' => $windowStart,
        'window_end' => $windowEnd,
        'daypart' => $daypart,
        'exclude_closer' => !empty($chore['excludeCloser']) ? 1 : 0,
        'exclude_opener' => !empty($chore['excludeOpener']) ? 1 : 0,
        'lead_time_minutes' => normalizeInt($chore['leadTimeMinutes'] ?? $chore['leadTime'] ?? null),
        'deadline_time' => $deadlineTime,
        'allow_multiple_assignees' => (!empty($chore['allowMultipleAssignees'])
            || !empty($chore['allowMultiple'])) ? 1 : 0,
        'max_per_day' => normalizeInt($chore['maxPerDay'] ?? null),
        'max_per_shift' => normalizeInt($chore['maxPerShift'] ?? null),
        'max_per_employee_per_day' => normalizeInt($chore['maxPerEmployeePerDay'] ?? null),
        'min_staff_level' => normalizeInt($chore['minStaffLevel'] ?? null),
        'estimated_duration_minutes' => normalizeInt($chore['estimatedDurationMinutes'] ?? $chore['estimatedDuration'] ?? null),
        'assigned_to' => normalizeInt($chore['assignedTo'] ?? null),
    ];
}

function truncateString(string $value, int $length): string
{
    $value = trim($value);
    if ($value === '') {
        return '';
    }
    if (function_exists('mb_substr')) {
        return mb_substr($value, 0, $length);
    }
    return substr($value, 0, $length);
}

function normalizeChoreFrequency(string $frequency): string
{
    $allowed = ['once', 'daily', 'weekly', 'monthly', 'per_shift'];
    $frequency = strtolower($frequency);
    return in_array($frequency, $allowed, true) ? $frequency : 'daily';
}

function normalizeActiveDays(mixed $value): ?string
{
    $days = [];
    if (is_string($value)) {
        $parts = array_map('trim', explode(',', $value));
    } elseif (is_array($value)) {
        $parts = $value;
    } else {
        $parts = [];
    }
    foreach ($parts as $part) {
        if (is_numeric($part)) {
            $name = indexToDayName((int) $part);
            if ($name !== null && !in_array($name, $days, true)) {
                $days[] = $name;
            }
            continue;
        }
        $part = strtolower(trim((string) $part));
        if ($part === '') {
            continue;
        }
        $index = dayNameToIndex($part);
        if ($index !== null) {
            $name = indexToDayName($index) ?? $part;
            if (!in_array($name, $days, true)) {
                $days[] = $name;
            }
        }
    }
    return $days === [] ? null : implode(',', $days);
}

/**
 * @param array<int|string> $days
 * @return array<int>
 */
function convertDaysToIndexes(array $days): array
{
    $indexes = [];
    foreach ($days as $day) {
        $index = is_numeric($day) ? (int) $day : dayNameToIndex((string) $day);
        if ($index !== null && !in_array($index, $indexes, true)) {
            $indexes[] = $index;
        }
    }
    sort($indexes);
    return $indexes;
}

function dayNameToIndex(string $day): ?int
{
    static $map = [
        'sun' => 0,
        'mon' => 1,
        'tue' => 2,
        'wed' => 3,
        'thu' => 4,
        'fri' => 5,
        'sat' => 6,
    ];
    $day = strtolower(trim($day));
    return $map[$day] ?? null;
}

function indexToDayName(int $index): ?string
{
    static $map = [
        0 => 'sun',
        1 => 'mon',
        2 => 'tue',
        3 => 'wed',
        4 => 'thu',
        5 => 'fri',
        6 => 'sat',
    ];
    return $map[$index] ?? null;
}

function normalizeDaypart(mixed $value): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $value = strtolower(trim($value));
    $allowed = ['open', 'mid', 'close', 'custom'];
    return in_array($value, $allowed, true) ? $value : null;
}

function normalizeTime(mixed $value): ?string
{
    if (!is_string($value)) {
        return null;
    }
    $value = trim($value);
    if ($value === '') {
        return null;
    }
    if (preg_match('/^\d{2}:\d{2}$/', $value) === 1) {
        return $value . ':00';
    }
    if (preg_match('/^\d{2}:\d{2}:\d{2}$/', $value) === 1) {
        return $value;
    }
    return null;
}

function normalizeInt(mixed $value): ?int
{
    if ($value === null || $value === '') {
        return null;
    }
    if (is_int($value)) {
        return $value;
    }
    if (!is_numeric($value)) {
        return null;
    }
    $int = (int) $value;
    return $int >= 0 ? $int : null;
}

function deleteChore(int $id, int $storeId): void
{
    $db = getDb();
    $stmt = $db->prepare('DELETE FROM chores WHERE id = ? AND store_id = ?');
    $stmt->execute([$id, $storeId]);
    auditLog('delete', 'chore', $id);
}
