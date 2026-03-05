<?php
declare(strict_types=1);

function fetchStores(?int $companyId = null): array
{
    $db = getDb();
    if ($companyId === null) {
        $stmt = $db->query('SELECT id, name, location FROM stores ORDER BY id');
    } else {
        $stmt = $db->prepare('SELECT id, name, location FROM stores WHERE company_id = ? ORDER BY id');
        $stmt->execute([$companyId]);
    }
    $rows   = $stmt->fetchAll(PDO::FETCH_ASSOC);
    $result = [];
    foreach ($rows as $row) {
        $row['name']     = sanitizeString($row['name'] ?? '');
        $row['location'] = sanitizeString($row['location'] ?? '');
        $result[]        = $row;
    }
    unset($rows, $row);
    return $result;
}

function saveStore(array $store, ?int $companyId = null): int
{
    $db = getDb();
    if (isset($store['id'])) {
        $sql    = 'UPDATE stores SET name = ?, location = ? WHERE id = ?';
        $params = [$store['name'] ?? '', $store['location'] ?? null, $store['id']];
        if ($companyId !== null) {
            $sql    .= ' AND company_id = ?';
            $params[] = $companyId;
        }
        $stmt = $db->prepare($sql);
        $stmt->execute($params);
        $id = (int) $store['id'];
    } else {
        $stmt = $db->prepare('INSERT INTO stores (name, location, company_id) VALUES (?, ?, ?)');
        $stmt->execute([$store['name'] ?? '', $store['location'] ?? null, $companyId ?? 1]);
        $id = (int) $db->lastInsertId();
    }
    auditLog('save', 'store', $id);
    return $id;
}

function deleteStore(int $id): void
{
    $db = getDb();
    $stmt = $db->prepare('DELETE FROM stores WHERE id = ?');
    $stmt->execute([$id]);
    auditLog('delete', 'store', $id);
}

function fetchCompanies(): array
{
    $db = getDb();
    $stmt = $db->query('SELECT id, name FROM companies ORDER BY id');
    return $stmt->fetchAll(PDO::FETCH_ASSOC);
}

function get_company_name(int $id): ?string
{
    $db = getDb();
    $stmt = $db->prepare('SELECT name FROM companies WHERE id = ?');
    $stmt->execute([$id]);
    $name = $stmt->fetchColumn();
    return $name !== false ? $name : null;
}

function saveCompany(array $company): int
{
    $db = getDb();
    if (!empty($company['id'])) {
        $stmt = $db->prepare('UPDATE companies SET name = ? WHERE id = ?');
        $stmt->execute([$company['name'] ?? '', $company['id']]);
        $id = (int) $company['id'];
    } else {
        $stmt = $db->prepare('INSERT INTO companies (name) VALUES (?)');
        $stmt->execute([$company['name'] ?? '']);
        $id = (int) $db->lastInsertId();
    }
    auditLog('save', 'company', $id);
    return $id;
}

function deleteCompany(int $id): bool
{
    $db   = getDb();
    $stmt = $db->prepare('DELETE FROM companies WHERE id = ?');
    try {
        $stmt->execute([$id]);
    } catch (PDOException $e) {
        if ($e->getCode() === '23000') {
            return false;
        }
        throw $e;
    }
    auditLog('delete', 'company', $id);
    return true;
}

function get_store_company_id(int $storeId): ?int
{
    $db = getDb();
    $stmt = $db->prepare('SELECT company_id FROM stores WHERE id = ?');
    $stmt->execute([$storeId]);
    $id = $stmt->fetchColumn();
    return $id !== false ? (int) $id : null;
}

