<?php

declare(strict_types=1);

define('TESTING', true);

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
require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/auth.php';

function assert_true(bool $cond, string $msg): void
{
    if (! $cond) {
        echo $msg . "\n";
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
    $db->exec("INSERT INTO users (company_id, email, emailHash, password_hash, home_store_id) VALUES ($companyId, 'user@example.com', '" . hash('sha256', 'user@example.com') . "', 'hash', $storeId)");
    $userId = (int) $db->lastInsertId();

    saveRole(['name' => 'company_admin', 'permissions' => []]);
    assign_user_company_role($adminId, $companyId, 'company_admin');

    // require_company_admin allows company admin
    $authAdmin = ['sub' => $adminId];
    require_company_admin($authAdmin, $companyId);

    // require_company_admin rejects regular user
    $authUser = ['sub' => $userId];
    $caught = false;
    ob_start();
    try {
        require_company_admin($authUser, $companyId);
    } catch (RuntimeException $e) {
        $caught = true;
    }
    ob_end_clean();
    assert_true($caught, 'require_company_admin allowed non-admin');

    // require_store_access allows store user via token
    $authStore = ['sub' => $userId, 'stores' => [$storeId]];
    $cid = require_store_access($authStore, $storeId);
    assert_true($cid === $companyId, 'require_store_access returned wrong company');

    // require_store_access allows company admin without store listing
    require_store_access($authAdmin, $storeId);

    // require_store_access rejects unauthorized user
    $caught = false;
    ob_start();
    try {
        require_store_access($authUser, $storeId);
    } catch (RuntimeException $e) {
        $caught = true;
    }
    ob_end_clean();
    assert_true($caught, 'require_store_access allowed unauthorized user');
} finally {
    teardown_test_db($db);
}

echo "auth helper tests passed\n";
