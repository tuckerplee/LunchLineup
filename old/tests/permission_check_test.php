<?php

declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

function getDb(): PDO
{
    global $db;
    return $db;
}

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    // no-op for tests
}

require __DIR__ . '/../src/data/roles.php';

function assert_true(bool $condition, string $message): void
{
    if (! $condition) {
        echo $message . "\n";
        exit(1);
    }
}

try {
    $db->exec("INSERT INTO companies (name) VALUES ('Acme')");
    $companyId = (int) $db->lastInsertId();

    $db->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main')");
    $storeId = (int) $db->lastInsertId();

    $db->exec("INSERT INTO users (company_id, email, emailHash, password_hash, home_store_id) VALUES ($companyId, 'admin@example.com', '" . hash('sha256', 'admin@example.com') . "', 'hash', $storeId)");
    $adminId = (int) $db->lastInsertId();
    $db->exec("INSERT INTO users (company_id, email, emailHash, password_hash, home_store_id) VALUES ($companyId, 'manager@example.com', '" . hash('sha256', 'manager@example.com') . "', 'hash', $storeId)");
    $managerId = (int) $db->lastInsertId();

    $db->exec("INSERT INTO users (company_id, email, emailHash, password_hash, home_store_id) VALUES ($companyId, 'user@example.com', '" . hash('sha256', 'user@example.com') . "', 'hash', $storeId)");
    $userId = (int) $db->lastInsertId();

    saveRole(['name' => 'manager', 'permissions' => ['edit']]);
    saveRole(['name' => 'clerk', 'permissions' => ['view']]);
    saveRole(['name' => 'company_admin', 'permissions' => []]);
    saveRole(['name' => 'super_admin', 'permissions' => []]);

    assign_user_store_role($adminId, $storeId, 'manager');
    assign_user_store_role($managerId, $storeId, 'clerk');

    assign_user_company_role($adminId, $companyId, 'super_admin');
    assign_user_company_role($managerId, $companyId, 'company_admin');

    assert_true(user_has_role($adminId, $storeId, 'manager'), 'manager role missing');
    assert_true(! user_has_role($adminId, $storeId, 'clerk'), 'unexpected clerk role');

    assert_true(user_has_permission($adminId, $storeId, 'edit'), 'edit permission missing');
    assert_true(! user_has_permission($adminId, $storeId, 'view'), 'unexpected view permission');
    assert_true(! user_has_permission($managerId, $storeId, 'edit'), 'clerk should not edit');

    assert_true(is_super_admin($adminId), 'super admin not detected');
    assert_true(! is_super_admin($managerId), 'non-super admin flagged');

    assert_true(is_company_admin($adminId, $companyId), 'super admin not company admin');
    assert_true(is_company_admin($managerId, $companyId), 'company admin not detected');
    assert_true(! is_company_admin($userId, $companyId), 'user without role flagged as company admin');
} finally {
    teardown_test_db($db);
}

echo "permission check tests passed\n";
