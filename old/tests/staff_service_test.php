<?php

declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

function getDb(): PDO
{
    global $db;
    return $db;
}

require __DIR__ . '/util/db_table_has_column.php';

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    // no-op
}

require_once __DIR__ . '/../src/crypto.php';
function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

require __DIR__ . '/../src/data/staff.php';
require __DIR__ . '/../src/StaffService.php';

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

function assert_same($expected, $actual, string $msg): void
{
    if ($expected !== $actual) {
        echo $msg . "\n";
        exit(1);
    }
}

try {
    $db->exec("INSERT INTO companies (name) VALUES ('Acme')");
    $companyId = (int) $db->lastInsertId();
    $db->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main')");
    $storeId = (int) $db->lastInsertId();

    $service = new StaffService();
    $id      = $service->save([
        'storeId'   => $storeId,
        'companyId' => $companyId,
        'name'      => 'Alice',
    ]);

    $service->setAdmin($id, true);
    $stmt = $db->prepare('SELECT isAdmin FROM staff WHERE id = ?');
    $stmt->execute([$id]);
    assert_same(1, (int) $stmt->fetchColumn(), 'setAdmin failed');

    $service->setAdmin($id, false);
    $stmt->execute([$id]);
    assert_same(0, (int) $stmt->fetchColumn(), 'setAdmin reset failed');
} finally {
    teardown_test_db($db);
}

echo "staff service tests passed\n";
