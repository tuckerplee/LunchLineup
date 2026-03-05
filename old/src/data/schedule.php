<?php
declare(strict_types=1);

require_once __DIR__ . '/../crypto.php';

const SCHEDULER_HEADERS = [
    'Staff Name',
    'POS',
    'Shift (Hours)',
    'Break 1',
    'Lunch',
    'Break 2',
    'Tasks',
];

function fetchSchedule(int $storeId): array
{
    $db = getDb();
    $stmt = $db->prepare('SELECT s.date, s.store_id, st.id AS staff_id, st.name, s.shift_hours, s.pos, s.break1, s.break1_duration,
        s.lunch, s.lunch_duration, s.break2, s.break2_duration, s.breaks, s.tasks, s.sign_off
        FROM shifts s JOIN staff st ON st.id = s.staff_id WHERE s.store_id = ? ORDER BY s.date, s.id');
    $stmt->execute([$storeId]);
    $schedule = [];
    while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
        $date = $row['date'];
        if (!isset($schedule[$date])) {
            $schedule[$date] = ['employees' => []];
        }
        $breaks = $row['breaks'] ? json_decode($row['breaks'], true) : [];
        if (!is_array($breaks) || $breaks === []) {
            $breaks = [];
            if (($row['break1'] ?? '') !== '' || ($row['break1_duration'] ?? '') !== '') {
                $breaks[] = ['start' => $row['break1'], 'duration' => (int) $row['break1_duration']];
            }
            if (($row['lunch'] ?? '') !== '' || ($row['lunch_duration'] ?? '') !== '') {
                $breaks[] = ['start' => $row['lunch'], 'duration' => (int) $row['lunch_duration']];
            }
            if (($row['break2'] ?? '') !== '' || ($row['break2_duration'] ?? '') !== '') {
                $breaks[] = ['start' => $row['break2'], 'duration' => (int) $row['break2_duration']];
            }
        }

        $schedule[$date]['employees'][] = [
            'id'      => (int) $row['staff_id'],
            'storeId' => $row['store_id'] !== null ? (int) $row['store_id'] : null,
            'name'    => sanitizeString(decryptField($row['name'])),
            'shift'   => $row['shift_hours'] ?? '',
            'pos'     => $row['pos'] ?? '',
            'breaks'  => $breaks,
            'tasks'   => $row['tasks'] ? json_decode($row['tasks'], true) : [],
            'signOff' => $row['sign_off'] ?? '',
        ];
    }
    return $schedule;
}

function saveSchedule(array $schedule, ?int $defaultStoreId = null): void
{
    $db            = getDb();
    $storeIds      = [];
    $storeCompanies = [];
    $staffRecords  = [];

    if ($defaultStoreId !== null) {
        $defaultStoreId                    = (int) $defaultStoreId;
        $storeIds[$defaultStoreId]         = true;
        $storeCompanies[$defaultStoreId]   = get_store_company_id($defaultStoreId) ?? 1;
    }
    foreach ($schedule as $day) {
        foreach ($day['employees'] ?? [] as $emp) {
            $sid = $emp['storeId'] ?? $emp['store_id'] ?? $defaultStoreId;
            if ($sid === null) {
                throw new InvalidArgumentException('Missing storeId in schedule item');
            }
            $sid                   = (int) $sid;
            if (!isset($storeCompanies[$sid])) {
                $storeCompanies[$sid] = get_store_company_id($sid) ?? 1;
            }
            $cid                   = $storeCompanies[$sid];
            $storeIds[$sid]        = true;
            $storeCompanies[$sid]  = $cid;

            $staffId = $emp['id'] ?? null;
            if ($staffId === null) {
                throw new InvalidArgumentException('Missing staff id in schedule item');
            }
            if (!isset($staffRecords[$staffId])) {
                $staffRecords[$staffId] = [
                    'store_id'   => $sid,
                    'company_id' => $cid,
                    'name'       => $emp['name'] ?? '',
                ];
            }
        }
    }

    $existing = [];
    foreach (array_keys($storeIds) as $sid) {
        $existing[$sid] = fetchSchedule($sid);
    }

    $checkStore  = $db->prepare('SELECT 1 FROM stores WHERE id = ?');
    $insertStore = $db->prepare('INSERT INTO stores (id, company_id, name) VALUES (?, ?, ?)');
    foreach (array_keys($storeIds) as $sid) {
        $checkStore->execute([$sid]);
        if ($checkStore->fetchColumn() === false) {
            $insertStore->execute([$sid, $storeCompanies[$sid] ?? 1, 'Imported Store ' . $sid]);
            auditLog('save', 'store', $sid);
        }
    }

    $checkStaff  = $db->prepare('SELECT 1 FROM staff WHERE id = ?');
    $insertStaff = $db->prepare('INSERT INTO staff (id, store_id, company_id, name) VALUES (?, ?, ?, ?)');
    foreach ($staffRecords as $id => $staff) {
        $checkStaff->execute([$id]);
        if ($checkStaff->fetchColumn() === false) {
            $insertStaff->execute([
                $id,
                $staff['store_id'],
                $staff['company_id'],
                $staff['name'],
            ]);
            auditLog('save', 'staff', $id);
        }
    }

    $db->beginTransaction();
    $del = $db->prepare('DELETE FROM shifts WHERE store_id = ?');
    foreach (array_keys($storeIds) as $sid) {
        $del->execute([$sid]);
    }

    $stmt = $db->prepare('INSERT INTO shifts (staff_id, date, shift_hours, pos, break1, break1_duration, lunch, lunch_duration, break2, break2_duration, breaks, tasks, sign_off, store_id)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');

    foreach ($schedule as $date => $day) {
        $employees = $day['employees'] ?? [];
        foreach ($employees as $emp) {
            $breaks = $emp['breaks'] ?? [];
            if (!is_array($breaks) || $breaks === []) {
                $breaks = [];
                if (($emp['break1'] ?? '') !== '' || ($emp['break1Duration'] ?? '') !== '') {
                    $breaks[] = [
                        'start'    => $emp['break1'] ?? '',
                        'duration' => (int) ($emp['break1Duration'] ?? 0),
                    ];
                }
                if (($emp['lunch'] ?? '') !== '' || ($emp['lunchDuration'] ?? '') !== '') {
                    $breaks[] = [
                        'start'    => $emp['lunch'] ?? '',
                        'duration' => (int) ($emp['lunchDuration'] ?? 0),
                    ];
                }
                if (($emp['break2'] ?? '') !== '' || ($emp['break2Duration'] ?? '') !== '') {
                    $breaks[] = [
                        'start'    => $emp['break2'] ?? '',
                        'duration' => (int) ($emp['break2Duration'] ?? 0),
                    ];
                }
            }
            $empBreak1    = $breaks[0]['start'] ?? '';
            $empBreak1Dur = isset($breaks[0]['duration']) ? (string) $breaks[0]['duration'] : '';
            $empLunch     = $breaks[1]['start'] ?? '';
            $empLunchDur  = isset($breaks[1]['duration']) ? (string) $breaks[1]['duration'] : '';
            $empBreak2    = $breaks[2]['start'] ?? '';
            $empBreak2Dur = isset($breaks[2]['duration']) ? (string) $breaks[2]['duration'] : '';

            $storeId = $emp['storeId'] ?? $emp['store_id'] ?? $defaultStoreId;
            if ($storeId === null) {
                throw new InvalidArgumentException('Missing storeId in schedule item');
            }
            $storeId = (int) $storeId;

            $staffId = $emp['id'] ?? null;
            if ($staffId === null) {
                throw new InvalidArgumentException('Missing staff id in schedule item');
            }
            if (isAdmin((int) $staffId)) {
                throw new InvalidArgumentException('Admins cannot be scheduled');
            }

            $stmt->execute([
                $staffId,
                $date,
                $emp['shift'] ?? '',
                $emp['pos'] ?? '',
                $empBreak1,
                $empBreak1Dur,
                $empLunch,
                $empLunchDur,
                $empBreak2,
                $empBreak2Dur,
                json_encode($breaks),
                json_encode($emp['tasks'] ?? []),
                $emp['signOff'] ?? '',
                $storeId,
            ]);
        }
    }
    $db->commit();
    foreach (array_keys($storeIds) as $sid) {
        $newSchedule = fetchSchedule($sid);
        if (empty($existing[$sid]) && !empty($newSchedule)) {
            auditLog('save', 'schedule', $sid);
        } elseif (!empty($existing[$sid]) && empty($newSchedule)) {
            auditLog('clear', 'schedule', $sid);
        } elseif ($existing[$sid] != $newSchedule) {
            auditLog('modify', 'schedule', $sid);
        } else {
            auditLog('save', 'schedule', $sid);
        }
    }
}

function fetch_schedule_templates(): array
{
    $db = getDb();
    $stmt = $db->query('SELECT id, name, payload FROM schedule_templates ORDER BY id');
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetch_schedule_template(int $id): ?array
{
    $db = getDb();
    $stmt = $db->prepare('SELECT id, name, payload FROM schedule_templates WHERE id = ?');
    $stmt->execute([$id]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    return $row ?: null;
}

function save_schedule_template(array $template): int
{
    $db = getDb();
    if (isset($template['id'])) {
        $stmt = $db->prepare('UPDATE schedule_templates SET name = ?, payload = ? WHERE id = ?');
        $stmt->execute([
            $template['name'] ?? '',
            $template['payload'] ?? '',
            (int) $template['id'],
        ]);
        $id = (int) $template['id'];
    } else {
        $stmt = $db->prepare('INSERT INTO schedule_templates (name, payload) VALUES (?, ?)');
        $stmt->execute([
            $template['name'] ?? '',
            $template['payload'] ?? '',
        ]);
        $id = (int) $db->lastInsertId();
    }
    auditLog('save', 'schedule_template', $id);
    return $id;
}

function delete_schedule_template(int $id): void
{
    $db = getDb();
    $stmt = $db->prepare('DELETE FROM schedule_templates WHERE id = ?');
    $stmt->execute([$id]);
    auditLog('delete', 'schedule_template', $id);
}

