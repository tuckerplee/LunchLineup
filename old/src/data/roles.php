<?php
declare(strict_types=1);

function assign_user_store_role(int $userId, int $storeId, string $role): void
{
    $db = getDb();
    $stmt = $db->prepare('REPLACE INTO user_store_roles (user_id, store_id, role) VALUES (?, ?, ?)');
    $stmt->execute([$userId, $storeId, $role]);
    auditLog('save', 'user_store_role', $userId);
}

function assign_user_company_role(int $userId, int $companyId, string $role): void
{
    $db = getDb();
    $stmt = $db->prepare('REPLACE INTO user_company_roles (user_id, company_id, role) VALUES (?, ?, ?)');
    $stmt->execute([$userId, $companyId, $role]);
    auditLog('save', 'user_company_role', $userId);
}

function fetch_user_store_roles(int $userId): array
{
    $db = getDb();
    $stmt = $db->prepare('SELECT store_id, role FROM user_store_roles WHERE user_id = ?');
    $stmt->execute([$userId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetch_user_company_roles(int $userId): array
{
    $db = getDb();
    $stmt = $db->prepare('SELECT company_id, role FROM user_company_roles WHERE user_id = ?');
    $stmt->execute([$userId]);
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function fetchRoles(): array
{
    $db = getDb();
    $stmt = $db->query('SELECT id, name FROM roles ORDER BY id');
    $roles = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $permStmt = $db->prepare('SELECT permission FROM role_permissions WHERE role_id = ? ORDER BY permission');
    foreach ($roles as &$role) {
        $permStmt->execute([$role['id']]);
        $role['permissions'] = $permStmt->fetchAll(PDO::FETCH_COLUMN);
    }
    return $roles;
}

function fetch_role_name(int $roleId): ?string
{
    $db = getDb();
    $stmt = $db->prepare('SELECT name FROM roles WHERE id = ?');
    $stmt->execute([$roleId]);
    $name = $stmt->fetchColumn();

    return $name !== false ? $name : null;
}

function saveRole(array $role): int
{
    $db = getDb();
    $db->beginTransaction();
    if (isset($role['id'])) {
        $stmt = $db->prepare('UPDATE roles SET name = ? WHERE id = ?');
        $stmt->execute([$role['name'] ?? '', $role['id']]);
        $roleId = (int) $role['id'];
        $db->prepare('DELETE FROM role_permissions WHERE role_id = ?')->execute([$roleId]);
    } else {
        $stmt = $db->prepare('INSERT INTO roles (name) VALUES (?)');
        $stmt->execute([$role['name'] ?? '']);
        $roleId = (int) $db->lastInsertId();
    }
    $permStmt = $db->prepare('INSERT INTO role_permissions (role_id, permission) VALUES (?, ?)');
    foreach ($role['permissions'] ?? [] as $perm) {
        $permStmt->execute([$roleId, $perm]);
    }
    $db->commit();
    auditLog('save', 'role', $roleId);
    return $roleId;
}

function deleteRole(int $roleId): void
{
    $db = getDb();
    $db->prepare('DELETE FROM role_permissions WHERE role_id = ?')->execute([$roleId]);
    $db->prepare('DELETE FROM roles WHERE id = ?')->execute([$roleId]);
    auditLog('delete', 'role', $roleId);
}

function user_has_role(int $userId, int $storeId, string $role): bool
{
    $db = getDb();
    $stmt = $db->prepare('SELECT 1 FROM user_store_roles WHERE user_id = ? AND store_id = ? AND role = ?');
    $stmt->execute([$userId, $storeId, $role]);
    return (bool) $stmt->fetchColumn();
}

function user_has_permission(int $userId, int $storeId, string $permission): bool
{
    $db = getDb();
    $stmt = $db->prepare('SELECT 1 FROM user_store_roles usr JOIN roles r ON r.name = usr.role JOIN role_permissions rp ON rp.role_id = r.id AND rp.permission = ? WHERE usr.user_id = ? AND usr.store_id = ?');
    $stmt->execute([$permission, $userId, $storeId]);
    return (bool) $stmt->fetchColumn();
}

function user_has_company_role(int $userId, int $companyId, string $role): bool
{
    $db = getDb();
    $stmt = $db->prepare('SELECT 1 FROM user_company_roles WHERE user_id = ? AND company_id = ? AND role = ?');
    $stmt->execute([$userId, $companyId, $role]);
    return (bool) $stmt->fetchColumn();
}

function is_super_admin(int $userId): bool
{
    $db = getDb();
    $stmt = $db->prepare('SELECT 1 FROM user_company_roles WHERE user_id = ? AND role = ? LIMIT 1');
    $stmt->execute([$userId, 'super_admin']);
    return (bool) $stmt->fetchColumn();
}

function is_company_admin(int $userId, int $companyId): bool
{
    return user_has_company_role($userId, $companyId, 'super_admin')
        || user_has_company_role($userId, $companyId, 'company_admin');
}

/**
 * Synchronize user roles for the given stores.
 *
 * Ensures each store in the list has the provided roles (plus the implicit
 * `store` role) and removes any stale roles from other stores or roles no
 * longer assigned.
 *
 * @param array<int>        $storeIds
 * @param array<int,string> $roles
 */
function sync_user_roles(int $userId, array $storeIds, array $roles): void
{
    $existing = fetch_user_store_roles($userId);
    $current  = [];
    foreach ($existing as $r) {
        $sid  = (int) ($r['store_id'] ?? 0);
        $role = $r['role'] ?? '';
        $current[$sid][] = $role;
    }

    foreach ($storeIds as $sid) {
        $sid = (int) $sid;
        assign_user_store_role($userId, $sid, 'store');
        foreach ($roles as $role) {
            assign_user_store_role($userId, $sid, $role);
        }
    }

    foreach ($current as $sid => $roleList) {
        if (!in_array($sid, $storeIds, true)) {
            foreach ($roleList as $role) {
                remove_user_store_role($userId, (int) $sid, $role);
            }
            continue;
        }
        foreach ($roleList as $role) {
            if ($role !== 'store' && !in_array($role, $roles, true)) {
                remove_user_store_role($userId, (int) $sid, $role);
            }
        }
    }
}

function remove_user_store_role(int $userId, int $storeId, string $role): void
{
    $db = getDb();
    $stmt = $db->prepare('DELETE FROM user_store_roles WHERE user_id = ? AND store_id = ? AND role = ?');
    $stmt->execute([$userId, $storeId, $role]);
}

function remove_user_company_role(int $userId, int $companyId, string $role): void
{
    $db = getDb();
    $stmt = $db->prepare('DELETE FROM user_company_roles WHERE user_id = ? AND company_id = ? AND role = ?');
    $stmt->execute([$userId, $companyId, $role]);
}

