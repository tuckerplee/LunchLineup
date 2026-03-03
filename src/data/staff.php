<?php
declare(strict_types=1);

require_once __DIR__ . '/../crypto.php';

function staff_admin_column(): string
{
    static $column = null;
    if ($column !== null) {
        return $column;
    }
    if (db_table_has_column('staff', 'isAdmin')) {
        $column = 'isAdmin';
    } elseif (db_table_has_column('staff', 'is_admin')) {
        $column = 'is_admin';
    } else {
        $column = '';
    }
    return $column;
}

class StaffRepository
{
    private PDO $db;

    /** @var array<string,bool> */
    private static array $columnCache = [];

    public function __construct(PDO $db)
    {
        $this->db = $db;
    }

    private function hasColumn(string $name): bool
    {
        if (!array_key_exists($name, self::$columnCache)) {
            self::$columnCache[$name] = db_table_has_column('staff', $name);
        }
        return self::$columnCache[$name];
    }

    /**
     * @return array<int,array<string,mixed>>
     */
    private function list(?int $storeId, ?int $companyId, bool $includeAdmins): array
    {
        $hasStore   = $this->hasColumn('store_id');
        $hasComp    = $this->hasColumn('company_id');
        $hasLunch   = $this->hasColumn('lunch_duration');
        $hasPos     = $this->hasColumn('pos');
        $hasTasks   = $this->hasColumn('tasks');
        $adminCol   = staff_admin_column();
        $hasIsAdmin = $adminCol !== '';

        $cols = ['s.id', 's.name'];
        if ($hasStore) {
            $cols[] = 's.store_id';
        }
        if ($hasComp) {
            $cols[] = 's.company_id';
        } elseif ($companyId !== null && $hasStore) {
            $cols[] = 'st.company_id';
        }
        if ($hasLunch) {
            $cols[] = 's.lunch_duration';
        }
        if ($hasPos) {
            $cols[] = 's.pos';
        }
        if ($hasTasks) {
            $cols[] = 's.tasks';
        }
        if ($hasIsAdmin) {
            $cols[] = 's.' . $adminCol . ' AS isAdmin';
        }

        $sql    = 'SELECT ' . implode(', ', $cols) . ' FROM staff s';
        $params = [];
        if ($companyId !== null && !$hasComp && $hasStore) {
            $sql .= ' JOIN stores st ON st.id = s.store_id';
        }

        $conditions = [];
        if ($storeId !== null && $hasStore) {
            $conditions[] = 's.store_id = ?';
            $params[]     = $storeId;
        } elseif ($companyId !== null) {
            if ($hasComp) {
                $conditions[] = 's.company_id = ?';
                $params[]     = $companyId;
            } elseif ($hasStore) {
                $conditions[] = 'st.company_id = ?';
                $params[]     = $companyId;
            }
        }
        if ($hasIsAdmin && !$includeAdmins) {
            $conditions[] = 's.' . $adminCol . ' = 0';
        }
        if ($conditions) {
            $sql .= ' WHERE ' . implode(' AND ', $conditions);
        }
        $sql .= ' ORDER BY s.id';
        $stmt   = $this->db->prepare($sql);
        $stmt->execute($params);
        $rows   = $stmt->fetchAll(PDO::FETCH_ASSOC);
        $result = [];

        foreach ($rows as $row) {
            $row['storeId'] = isset($row['store_id']) && $row['store_id'] !== null
                ? (int) $row['store_id']
                : null;
            $row['companyId'] = isset($row['company_id']) && $row['company_id'] !== null
                ? (int) $row['company_id']
                : null;
            $row['lunchDuration'] = isset($row['lunch_duration']) && $row['lunch_duration'] !== null
                ? (int) $row['lunch_duration']
                : null;
            $row['pos'] = isset($row['pos']) && $row['pos'] !== null && $row['pos'] !== ''
                ? json_decode($row['pos'], true)
                : [];
            $decodedTasks = [];
            if (isset($row['tasks']) && $row['tasks'] !== null && $row['tasks'] !== '') {
                $parsed = json_decode((string) $row['tasks'], true);
                if (is_array($parsed)) {
                    $decodedTasks = normalize_task_preference_list($parsed);
                }
            }
            $row['tasks'] = $decodedTasks;
            $row['name'] = isset($row['name'])
                ? sanitizeString(decryptField($row['name']))
                : '';
            $row['isAdmin'] = isset($row['isAdmin']) ? (int) $row['isAdmin'] : 0;
            unset($row['store_id'], $row['company_id'], $row['lunch_duration'], $row['isAdmin']);
            $result[] = $row;
        }

        unset($rows, $row);
        return $result;
    }

    public function listByStore(int $storeId, bool $includeAdmins = false): array
    {
        return $this->list($storeId, null, $includeAdmins);
    }

    public function listByCompany(int $companyId, bool $includeAdmins = false): array
    {
        return $this->list(null, $companyId, $includeAdmins);
    }

    public function listAll(bool $includeAdmins = false): array
    {
        return $this->list(null, null, $includeAdmins);
    }
}

function fetchStaff(?int $storeId = null, ?int $companyId = null, bool $includeAdmins = false): array
{
    $repo = new StaffRepository(getDb());
    if ($storeId !== null) {
        return $repo->listByStore($storeId, $includeAdmins);
    }
    if ($companyId !== null) {
        return $repo->listByCompany($companyId, $includeAdmins);
    }
    return $repo->listAll($includeAdmins);
}

function fetch_company_staff(int $companyId, bool $includeAdmins = false): array
{
    $repo = new StaffRepository(getDb());
    return $repo->listByCompany($companyId, $includeAdmins);
}

/**
 * @param mixed $value
 * @return array<int|string>
 */
function normalize_task_preference_list(mixed $value): array
{
    if ($value === null) {
        return [];
    }

    if (!is_array($value)) {
        $value = [$value];
    }

    $normalized = [];
    foreach ($value as $item) {
        if ($item === null) {
            continue;
        }

        if (is_int($item)) {
            $normalized[] = $item;
            continue;
        }

        if (is_float($item)) {
            $normalized[] = (int) $item;
            continue;
        }

        if (is_bool($item)) {
            $normalized[] = $item ? 1 : 0;
            continue;
        }

        if (is_array($item)) {
            $normalized = array_merge(
                $normalized,
                normalize_task_preference_list($item)
            );
            continue;
        }

        if (is_string($item)) {
            $trimmed = trim($item);
            if ($trimmed === '') {
                continue;
            }
            if (preg_match('/^-?\d+$/', $trimmed) === 1) {
                $normalized[] = (int) $trimmed;
            } else {
                $normalized[] = sanitizeString($trimmed);
            }
            continue;
        }

        if (is_object($item) && property_exists($item, 'value')) {
            $normalized = array_merge(
                $normalized,
                normalize_task_preference_list($item->value)
            );
        }
    }

    $deduped = [];
    foreach ($normalized as $entry) {
        if (is_int($entry)) {
            if (!in_array($entry, $deduped, true)) {
                $deduped[] = $entry;
            }
            continue;
        }

        if (is_string($entry) && !in_array($entry, $deduped, true)) {
            $deduped[] = $entry;
        }
    }

    return $deduped;
}

function encode_task_preferences(mixed $value): string
{
    $list = normalize_task_preference_list($value);
    $json = json_encode($list);
    if ($json === false) {
        return '[]';
    }

    return $json;
}

function saveStaff(array $staff, ?int $storeId = null, ?int $companyId = null): void
{
    $db         = getDb();
    $adminCol   = staff_admin_column();
    $hasIsAdmin = $adminCol !== '';
    $db->beginTransaction();

    $storeIds   = [];
    $companyIds = [];
    foreach ($staff as $person) {
        if (($person['isAdmin'] ?? $person['isAdmin'] ?? 0)) {
            throw new InvalidArgumentException('Admins cannot be added to staff');
        }
        $sid = $storeId ?? $person['storeId'] ?? $person['store_id'] ?? null;
        $cid = $companyId ?? $person['companyId'] ?? $person['company_id'] ?? null;
        if ($cid === null && $sid !== null) {
            $cid = get_store_company_id((int) $sid);
        }
        if ($cid === null) {
            throw new InvalidArgumentException('Missing companyId in staff entry');
        }
        if ($sid !== null) {
            $storeIds[(int) $sid] = true;
        } else {
            $companyIds[(int) $cid] = true;
        }
    }

    $delStore = $db->prepare('DELETE FROM staff WHERE store_id = ?');
    foreach (array_keys($storeIds) as $sid) {
        $delStore->execute([$sid]);
    }
    $delCompany = $db->prepare('DELETE FROM staff WHERE store_id IS NULL AND company_id = ?');
    foreach (array_keys($companyIds) as $cid) {
        $delCompany->execute([$cid]);
    }

    $cols = ['id', 'store_id', 'company_id', 'name', 'lunch_duration', 'pos', 'tasks'];
    $qs   = ['?', '?', '?', '?', '?', '?', '?'];
    if ($hasIsAdmin) {
        $cols[] = $adminCol;
        $qs[]   = '?';
    }
    $stmt = $db->prepare('INSERT INTO staff (' . implode(', ', $cols) . ') VALUES (' . implode(', ', $qs) . ')');
    foreach ($staff as $person) {
        $sid = $storeId ?? $person['storeId'] ?? $person['store_id'] ?? null;
        $cid = $companyId ?? $person['companyId'] ?? $person['company_id'] ?? null;
        if ($cid === null && $sid !== null) {
            $cid = get_store_company_id((int) $sid);
        }
        if ($cid === null) {
            throw new InvalidArgumentException('Missing companyId in staff entry');
        }
        if (($person['isAdmin'] ?? $person['isAdmin'] ?? 0)) {
            throw new InvalidArgumentException('Admins cannot be added to staff');
        }
        $pos = $person['pos'] ?? $person['preferredRegisters'] ?? null;
        if (is_array($pos)) {
            $pos = json_encode($pos);
        }
        $tasks = encode_task_preferences($person['tasks'] ?? $person['preferredTasks'] ?? null);
        $params = [
            $person['id'] ?? null,
            $sid,
            $cid,
            encryptField($person['name'] ?? ''),
            $person['lunchDuration'] ?? $person['lunch_duration'] ?? 30,
            $pos,
            $tasks,
        ];
        if ($hasIsAdmin) {
            $params[] = $person['isAdmin'] ?? $person['isAdmin'] ?? 0;
        }
        $stmt->execute($params);
    }

    $db->commit();
    auditLog('save', 'staff');
}

function save_staff_member(array $staff): int
{
    $db        = getDb();
    $adminCol  = staff_admin_column();
    $hasIsAdmin = $adminCol !== '';
    if (($staff['isAdmin'] ?? $staff['isAdmin'] ?? 0)) {
        throw new InvalidArgumentException('Admins cannot be added to staff');
    }
    $storeId = $staff['storeId'] ?? $staff['store_id'] ?? null;
    if ($storeId !== null && $storeId !== '') {
        $storeId = (int) $storeId;
    } else {
        $storeId = null;
    }

    $companyId = $staff['companyId'] ?? $staff['company_id'] ?? null;
    if ($companyId !== null && $companyId !== '') {
        $companyId = (int) $companyId;
    } else {
        $companyId = null;
    }
    if ($companyId === null && $storeId !== null) {
        $companyId = get_store_company_id((int) $storeId);
    }
    if ($companyId === null) {
        throw new InvalidArgumentException('Missing companyId in staff entry');
    }

    $pos = $staff['pos'] ?? $staff['preferredRegisters'] ?? null;
    if (is_array($pos)) {
        $pos = json_encode($pos);
    }
    $tasks = encode_task_preferences($staff['tasks'] ?? $staff['preferredTasks'] ?? null);
    if (!empty($staff['id'])) {
        $sql    = 'UPDATE staff SET store_id = ?, company_id = ?, name = ?, lunch_duration = ?, pos = ?, tasks = ?';
        $params = [
            $storeId,
            $companyId,
            encryptField($staff['name'] ?? ''),
            $staff['lunchDuration'] ?? $staff['lunch_duration'] ?? 30,
            $pos,
            $tasks,
        ];
        if ($hasIsAdmin) {
            $sql      .= ", {$adminCol} = ?";
            $params[] = $staff['isAdmin'] ?? $staff['isAdmin'] ?? 0;
        }
        $sql      .= ' WHERE id = ?';
        $params[] = $staff['id'];
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $id = (int) $staff['id'];
    } else {
        $cols = ['store_id', 'company_id', 'name', 'lunch_duration', 'pos', 'tasks'];
        $qs   = ['?', '?', '?', '?', '?', '?'];
        $params = [
            $storeId,
            $companyId,
            encryptField($staff['name'] ?? ''),
            $staff['lunchDuration'] ?? $staff['lunch_duration'] ?? 30,
            $pos,
            $tasks,
        ];
        if ($hasIsAdmin) {
            $cols[]   = $adminCol;
            $qs[]     = '?';
            $params[] = $staff['isAdmin'] ?? $staff['isAdmin'] ?? 0;
        }
        $stmt = $db->prepare('INSERT INTO staff (' . implode(', ', $cols) . ') VALUES (' . implode(', ', $qs) . ')');
        $stmt->execute($params);
        $id = (int) $db->lastInsertId();
    }
    auditLog('save', 'staff', $id);
    return $id;
}

function deleteStaff(int $id): void
{
    $db   = getDb();
    $stmt = $db->prepare('DELETE FROM staff WHERE id = ?');
    $stmt->execute([$id]);
    auditLog('delete', 'staff', $id);
}

function isAdmin(int $userId): bool
{
    $db  = getDb();
    $col = staff_admin_column();
    if ($col === '') {
        return false;
    }
    $stmt = $db->prepare("SELECT {$col} FROM staff WHERE id = ?");
    $stmt->execute([$userId]);
    return (bool) $stmt->fetchColumn();
}
