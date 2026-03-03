<?php
declare(strict_types=1);

require_once __DIR__ . '/../crypto.php';
// Role helpers required for admin sync
require_once __DIR__ . '/roles.php';
require_once __DIR__ . '/staff.php';

/**
 * @return array<int, string>
 */
function getUserUsernameHashColumns(): array
{
    static $columns = null;
    if ($columns !== null) {
        return $columns;
    }

    $columns = [];
    $candidates = ['usernameHash', 'username_hash', 'emailHash', 'email_hash'];
    foreach ($candidates as $candidate) {
        if (db_table_has_column('users', $candidate)) {
            $columns[] = $candidate;
        }
    }

    if ($columns === []) {
        throw new RuntimeException(
            'users username hash column missing. Run "php scripts/upgrade.php" to migrate login columns before retrying.'
        );
    }

    return $columns;
}

function getUserUsernameHashColumn(): string
{
    $columns = getUserUsernameHashColumns();
    foreach ($columns as $column) {
        if (stripos($column, 'username') !== false) {
            return $column;
        }
    }

    return $columns[0];
}

function getUserUsernameColumn(): string
{
    static $column = null;
    if ($column !== null) {
        return $column;
    }

    if (db_table_has_column('users', 'username')) {
        $column = 'username';
        return $column;
    }

    if (db_table_has_column('users', 'email')) {
        $column = 'email';
        return $column;
    }

    throw new RuntimeException(
        'users username column missing. Run "php scripts/upgrade.php" to migrate login columns before retrying.'
    );
}

function fetchUsers(): array
{
    $db          = getDb();
    $usernameCol = getUserUsernameColumn();
    $sql = 'SELECT u.id, u.' . $usernameCol . ' AS username_value, u.home_store_id, u.locked_until, s.name,'
        . ' (uca.user_id IS NOT NULL) AS isAdmin'
        . ' FROM users u'
        . ' LEFT JOIN staff s ON u.id = s.id'
        . ' LEFT JOIN (SELECT DISTINCT user_id FROM user_company_roles'
        . " WHERE role IN ('company_admin','super_admin')) uca ON uca.user_id = u.id"
        . ' ORDER BY u.id';
    $rows = $db->query($sql)->fetchAll(PDO::FETCH_ASSOC);

    $result = [];
    foreach ($rows as $row) {
        $row['homeStoreId'] = (int) $row['home_store_id'];
        $row['isAdmin']     = (bool) $row['isAdmin'];
        $row['name']        = isset($row['name'])
            ? sanitizeString(decryptField($row['name']))
            : '';
        $row['username']    = isset($row['username_value'])
            ? sanitizeString(decryptField((string) $row['username_value']))
            : '';
        $row['lockedUntil'] = $row['locked_until'] !== null ? $row['locked_until'] : null;
        $roles              = fetch_user_store_roles((int) $row['id']);
        $storeIds           = [];
        $userRoles          = [];
        foreach ($roles as $r) {
            $role = $r['role'] ?? '';
            if ($role === 'store') {
                $storeIds[] = (int) $r['store_id'];
            } else {
                $userRoles[] = $role;
            }
        }
        $row['storeIds'] = $storeIds;
        $row['roles']    = array_values(array_unique($userRoles));
        unset($row['home_store_id'], $row['locked_until'], $row['username_value']);
        unset($roles, $storeIds, $userRoles, $r);
        $result[] = $row;
    }
    unset($rows, $row);

    return $result;
}

function fetch_company_users(int $companyId, array $opts = []): array
{
    $search       = trim($opts['search'] ?? '');
    $page         = isset($opts['page']) ? max(1, (int) $opts['page']) : null;
    $limit        = (int) ($opts['limit'] ?? 10);
    $admins       = $opts['admins'] ?? null;
    $usernameCol  = getUserUsernameColumn();
    $hashColumn   = getUserUsernameHashColumn();

    $db  = getDb();
    $adminSub = 'SELECT user_id,'
        . ' MAX(role IN (\'company_admin\', \'super_admin\')) AS is_admin_role,'
        . ' MAX(role = \'super_admin\') AS is_super_admin_role'
        . " FROM user_company_roles WHERE role IN ('company_admin','super_admin')";
    if ($companyId > 0) {
        $adminSub .= ' AND company_id = :company';
    }
    $adminSub .= ' GROUP BY user_id';
    $sql = 'SELECT u.id, u.' . $usernameCol . ' AS username_value, u.home_store_id, u.locked_until, s.name,'
        . ' COALESCE(uca.is_admin_role, 0) AS is_admin_role,'
        . ' COALESCE(uca.is_super_admin_role, 0) AS is_super_admin_role'
        . ' FROM users u'
        . ' LEFT JOIN staff s ON u.id = s.id';
    if ($companyId > 0) {
        $sql .= ' JOIN stores st ON u.home_store_id = st.id';
    }
    $sql .= ' LEFT JOIN (' . $adminSub . ') uca ON uca.user_id = u.id';
    $conditions = [];
    if ($companyId > 0) {
        $conditions[] = 'st.company_id = :company';
    }
    if ($search !== '') {
        $conditions[] = 'u.' . $hashColumn . ' = :search';
    }
    if ($admins === true) {
        $conditions[] = 'COALESCE(uca.is_admin_role, 0) = 1';
    } elseif ($admins === false) {
        $conditions[] = 'COALESCE(uca.is_admin_role, 0) = 0';
    }
    if (!empty($opts['excludeSuperAdmins'])) {
        $conditions[] = 'COALESCE(uca.is_super_admin_role, 0) = 0';
    }
    if ($conditions !== []) {
        $sql .= ' WHERE ' . implode(' AND ', $conditions);
    }
    $sql .= ' ORDER BY u.id';
    if ($page !== null) {
        $sql .= ' LIMIT :limit OFFSET :offset';
    }

    $stmt = $db->prepare($sql);
    if ($companyId > 0) {
        $stmt->bindValue(':company', $companyId, PDO::PARAM_INT);
    }
    if ($search !== '') {
        $stmt->bindValue(':search', usernameHash($search));
    }
    if ($page !== null) {
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', ($page - 1) * $limit, PDO::PARAM_INT);
    }
    $stmt->execute();
    $rows   = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $result = [];
    foreach ($rows as $row) {
        $row['homeStoreId'] = (int) $row['home_store_id'];
        $row['isAdmin']     = (bool) ($row['is_admin_role'] ?? false);
        $row['isSuperAdmin'] = (bool) ($row['is_super_admin_role'] ?? false);
        $row['lockedUntil'] = $row['locked_until'] !== null ? $row['locked_until'] : null;
        $row['name']        = isset($row['name']) ? sanitizeString(decryptField((string) $row['name'])) : '';
        $row['username']    = isset($row['username_value']) ? sanitizeString(decryptField((string) $row['username_value'])) : '';
        $rolesData          = fetch_user_store_roles((int) $row['id']);
        $storeIds           = [];
        $userRoles          = [];
        foreach ($rolesData as $r) {
            $sid  = (int) $r['store_id'];
            $role = $r['role'] ?? '';
            if ($role === 'store') {
                if ($companyId === 0 || get_store_company_id($sid) === $companyId) {
                    $storeIds[] = $sid;
                }
            } else {
                if ($companyId === 0 || get_store_company_id($sid) === $companyId) {
                    $userRoles[] = $role;
                }
            }
        }
        $row['storeIds'] = $storeIds;
        $row['roles']    = array_values(array_unique($userRoles));
        unset(
            $row['home_store_id'],
            $row['locked_until'],
            $row['username_value'],
            $row['is_admin_role'],
            $row['is_super_admin_role']
        );
        unset($rolesData, $storeIds, $userRoles, $r);
        $result[] = $row;
    }
    unset($rows, $row);

    return $result;
}

function fetch_user_is_admin(int $userId, int $companyId = 0): bool
{
    $db      = getDb();
    $sql     = 'SELECT 1 FROM user_company_roles WHERE user_id = ?'
        . " AND role IN ('company_admin','super_admin')";
    $params  = [$userId];
    if ($companyId > 0) {
        $sql     .= ' AND company_id = ?';
        $params[] = $companyId;
    }
    $sql  .= ' LIMIT 1';
    $stmt  = $db->prepare($sql);
    $stmt->execute($params);

    return (bool) $stmt->fetchColumn();
}

function saveUser(array $user): int
{
    $db                = getDb();
    $lockedUntil       = $user['lockedUntil'] ?? null;
    $companyId         = isset($user['companyId']) ? (int) $user['companyId'] : null;
    $isAdmin           = !empty($user['isAdmin']);
    $isStaff           = !empty($user['isStaff']) || $isAdmin;
    $hasUserCompany    = db_table_has_column('users', 'company_id');
    $hasStaffComp      = db_table_has_column('staff', 'company_id');
    $usernameColumn    = getUserUsernameColumn();
    $usernameHashCols  = getUserUsernameHashColumns();
    $usernameValue     = $user['username'] ?? '';
    $usernameHashValue = usernameHash($usernameValue);

    if ($companyId === null && isset($user['homeStoreId'])) {
        $cid = get_store_company_id((int) $user['homeStoreId']);
        if ($cid !== null) {
            $companyId = $cid;
        }
    }
    $companyId ??= 1;

    if (!empty($user['id'])) {
        $fields = [$usernameColumn . ' = ?'];
        $params = [encryptField($usernameValue)];
        foreach ($usernameHashCols as $column) {
            $fields[] = $column . ' = ?';
            $params[] = $usernameHashValue;
        }
        $fields[] = 'home_store_id = ?';
        $params[] = $user['homeStoreId'];
        $fields[] = 'locked_until = ?';
        $params[] = $lockedUntil;
        if ($hasUserCompany) {
            $fields[] = 'company_id = ?';
            $params[] = $companyId;
        }
        if (!empty($user['password'])) {
            $fields[] = 'password_hash = ?';
            $params[] = password_hash($user['password'], PASSWORD_DEFAULT);
        }
        $params[] = $user['id'];
        $sql      = 'UPDATE users SET ' . implode(', ', $fields) . ', updated_at = CURRENT_TIMESTAMP WHERE id = ?';
        $stmt     = $db->prepare($sql);
        $stmt->execute($params);
        $id = (int) $user['id'];
    } else {
        $columns      = [$usernameColumn];
        $placeholders = ['?'];
        $params       = [encryptField($usernameValue)];
        foreach ($usernameHashCols as $column) {
            $columns[]      = $column;
            $placeholders[] = '?';
            $params[]       = $usernameHashValue;
        }
        $columns[]      = 'password_hash';
        $placeholders[] = '?';
        $passwordSource = $user['password'] ?? bin2hex(random_bytes(8));
        $params[]       = password_hash($passwordSource, PASSWORD_DEFAULT);
        $columns[]      = 'home_store_id';
        $placeholders[] = '?';
        $params[]       = $user['homeStoreId'];
        $columns[]      = 'locked_until';
        $placeholders[] = '?';
        $params[]       = $lockedUntil;
        if ($hasUserCompany) {
            $columns[]      = 'company_id';
            $placeholders[] = '?';
            $params[]       = $companyId;
        }
        $sql  = 'INSERT INTO users (' . implode(', ', $columns) . ') VALUES (' . implode(', ', $placeholders) . ')';
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $id = (int) $db->lastInsertId();
    }

    if ($isStaff) {
        $adminCol = staff_admin_column();
        $fields   = ['id', 'name', 'store_id', $adminCol];
        $place    = ['?', '?', '?', '?'];
        $update   = ['name = VALUES(name)', 'store_id = VALUES(store_id)',
            $adminCol . ' = VALUES(' . $adminCol . ')'];
        $params   = [$id, encryptField($user['name'] ?? ''), $user['homeStoreId'], $isAdmin ? 1 : 0];
        if ($hasStaffComp) {
            $fields[] = 'company_id';
            $place[]  = '?';
            $update[] = 'company_id = VALUES(company_id)';
            $params[] = $companyId;
        }
        $sql  = 'INSERT INTO staff (' . implode(', ', $fields) . ') VALUES (' . implode(', ', $place)
            . ') ON DUPLICATE KEY UPDATE ' . implode(', ', $update);
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
    } else {
        $stmt = $db->prepare('DELETE FROM staff WHERE id = ?');
        $stmt->execute([$id]);
    }

    if ($companyId > 0) {
        if ($isAdmin) {
            assign_user_company_role($id, $companyId, 'company_admin');
        } else {
            remove_user_company_role($id, $companyId, 'company_admin');
        }
    }

    auditLog('save', 'user', $id);

    return $id;
}

function deleteUser(int $id): void
{
    $db = getDb();
    $db->prepare('DELETE FROM user_store_roles WHERE user_id = ?')->execute([$id]);
    $db->prepare('DELETE FROM staff WHERE id = ?')->execute([$id]);
    $db->prepare('DELETE FROM users WHERE id = ?')->execute([$id]);
    auditLog('delete', 'user', $id);
}

function find_or_create_user(string $username): int
{
    $db          = getDb();
    $hashColumn  = getUserUsernameHashColumn();
    $usernameCol = getUserUsernameColumn();
    $stmt = $db->prepare('SELECT id FROM users WHERE ' . $hashColumn . ' = ?');
    $stmt->execute([usernameHash($username)]);
    $id = $stmt->fetchColumn();
    if ($id !== false) {
        return (int) $id;
    }
    $usernameHashValue = usernameHash($username);
    $columns        = [$usernameCol];
    $placeholders   = ['?'];
    $params         = [encryptField($username)];
    foreach (getUserUsernameHashColumns() as $column) {
        $columns[]      = $column;
        $placeholders[] = '?';
        $params[]       = $usernameHashValue;
    }
    $columns[]      = 'password_hash';
    $placeholders[] = '?';
    $params[]       = password_hash(bin2hex(random_bytes(16)), PASSWORD_DEFAULT);
    $sql  = 'INSERT INTO users (' . implode(', ', $columns) . ') VALUES (' . implode(', ', $placeholders) . ')';
    $stmt = $db->prepare($sql);
    $stmt->execute($params);
    $newId = (int) $db->lastInsertId();
    auditLog('save', 'user', $newId);

    return $newId;
}

function find_user_by_username(string $username): ?array
{
    $db          = getDb();
    $hashColumn  = getUserUsernameHashColumn();
    $usernameCol = getUserUsernameColumn();
    $stmt = $db->prepare('SELECT * FROM users WHERE ' . $hashColumn . ' = ?');
    $stmt->execute([usernameHash($username)]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        return null;
    }
    if (array_key_exists($usernameCol, $row)) {
        $row[$usernameCol] = decryptField((string) $row[$usernameCol]);
    }

    return $row;
}

function create_password_reset(int $userId): string
{
    $db = getDb();
    $db->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$userId]);
    $token = bin2hex(random_bytes(16));
    $stmt = $db->prepare('INSERT INTO password_resets (user_id, token, expires_at) VALUES (?, ?, DATE_ADD(NOW(), INTERVAL 1 HOUR))');
    $stmt->execute([$userId, $token]);
    auditLog('create', 'password_reset', $userId);

    return $token;
}

function reset_password_with_token(string $token, string $newPassword): bool
{
    $db = getDb();
    $stmt = $db->prepare('SELECT user_id FROM password_resets WHERE token = ? AND expires_at > NOW()');
    $stmt->execute([$token]);
    $userId = $stmt->fetchColumn();
    if ($userId === false) {
        return false;
    }
    $hash = password_hash($newPassword, PASSWORD_DEFAULT);
    $stmt = $db->prepare('UPDATE users SET password_hash = ?, locked_until = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    $stmt->execute([$hash, $userId]);
    $db->prepare('DELETE FROM password_resets WHERE user_id = ?')->execute([$userId]);
    auditLog('update', 'user', (int) $userId);

    return true;
}

function queueInvitation(string $username, int $storeId, string $role): void
{
    $db   = getDb();
    $stmt = $db->prepare('INSERT INTO mail_queue (username, store_id, role, template, status) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$username, $storeId, $role, 'invitation.txt', 'pending']);
    auditLog('invite', 'invitation');
}

function fetch_mail_queue(int $companyId): array
{
    $db   = getDb();
    $stmt = $db->prepare('SELECT mq.id, mq.username, mq.store_id, s.name AS store_name, mq.role, mq.status FROM mail_queue mq LEFT JOIN stores s ON s.id = mq.store_id WHERE s.company_id = ? ORDER BY mq.id DESC');
    $stmt->execute([$companyId]);

    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function update_mail_queue_status(int $id, string $status): void
{
    $db   = getDb();
    $stmt = $db->prepare('UPDATE mail_queue SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?');
    $stmt->execute([$status, $id]);
    auditLog('update', 'mail_queue', $id);
}
