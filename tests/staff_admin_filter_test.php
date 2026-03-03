<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

$db = create_test_db();

function getDb(): PDO
{
    global $db;
    return $db;
}

require __DIR__ . '/util/db_table_has_column.php';

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    // no-op for tests
}

require_once __DIR__ . '/../src/crypto.php';
function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}
require __DIR__ . '/../src/data/staff.php';

function assert_same($expected, $actual): void
{
    if ($expected !== $actual) {
        echo "Assertion failed: expected ";
        var_export($expected);
        echo ", got ";
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

    $stmt = $db->prepare('INSERT INTO staff (id, store_id, company_id, name, isAdmin) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([1, $storeId, $companyId, encryptField('Alice'), 0]);
    $stmt->execute([2, $storeId, $companyId, encryptField('Bob'), 1]);

    $rows = fetchStaff($storeId);
    assert_same(1, count($rows));
    assert_same('Alice', $rows[0]['name']);

    $rows = fetchStaff($storeId, null, true);
    assert_same(2, count($rows));

    $rows = fetchStaff(null, null, true);
    assert_same(2, count($rows));
    $names = array_column($rows, 'name');
    sort($names);
    assert_same(['Alice', 'Bob'], $names);
} finally {
    teardown_test_db($db);
}

echo "staff admin filter tests passed\n";
