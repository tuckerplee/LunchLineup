<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

function getDb(): PDO
{
    global $db;
    return $db;
}

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    // no-op for tests
}

require_once __DIR__ . '/../src/crypto.php';

require __DIR__ . '/util/db_table_has_column.php';

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/data/users.php';

function assert_same(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        echo 'Assertion failed: expected ';
        var_export($expected);
        echo ', got ';
        var_export($actual);
        echo "\n";
        exit(1);
    }
}

try {
    $db->exec("INSERT INTO companies (name) VALUES ('Acme')");
    $companyId = (int) $db->lastInsertId();
    $db->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main')");
    $storeId = (int) $db->lastInsertId();

    $stmt = $db->prepare('INSERT INTO users (company_id, email, emailHash, password_hash, home_store_id) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$companyId, encryptField('admin@example.com'), emailHash('admin@example.com'), 'hash', $storeId]);
    $adminId = (int) $db->lastInsertId();
    $stmt->execute([$companyId, encryptField('user@example.com'), emailHash('user@example.com'), 'hash', $storeId]);
    $userId = (int) $db->lastInsertId();

    $staffStmt = $db->prepare('INSERT INTO staff (id, store_id, company_id, name, isAdmin) VALUES (?, ?, ?, ?, ?)');
    $staffStmt->execute([$adminId, $storeId, $companyId, encryptField('Admin'), 1]);
    $staffStmt->execute([$userId, $storeId, $companyId, encryptField('User'), 0]);
    $roleStmt = $db->prepare('INSERT INTO user_company_roles (user_id, company_id, role) VALUES (?, ?, ?)');
    $roleStmt->execute([$adminId, $companyId, 'company_admin']);

    $admins = fetch_company_users($companyId, ['admins' => true]);
    assert_same(1, count($admins));
    assert_same($adminId, (int) $admins[0]['id']);

    $nonAdmins = fetch_company_users($companyId, ['admins' => false]);
    assert_same(1, count($nonAdmins));
    assert_same($userId, (int) $nonAdmins[0]['id']);
} finally {
    teardown_test_db($db);
}

echo "user admin filter tests passed\n";

