<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

function getDb(): PDO {
    global $db;
    return $db;
}

require __DIR__ . '/util/db_table_has_column.php';

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void {
    // no-op
}

require_once __DIR__ . '/../src/crypto.php';
function sanitizeString(string $value): string { return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); }
require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/data/staff.php';

try {
    $db->exec("INSERT INTO companies (name) VALUES ('Acme')");
    $companyId = (int) $db->lastInsertId();
    $db->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main')");
    $storeId = (int) $db->lastInsertId();

    try {
        saveStaff([
            ['id' => 1, 'name' => 'Admin', 'storeId' => $storeId, 'companyId' => $companyId, 'isAdmin' => 1]
        ]);
        echo "Expected exception not thrown\n";
        exit(1);
    } catch (InvalidArgumentException $e) {
        // expected
    }

    $count = (int) $db->query('SELECT COUNT(*) FROM staff')->fetchColumn();
    if ($count !== 0) {
        echo "Staff table should be empty, found $count\n";
        exit(1);
    }
} finally {
    teardown_test_db($db);
}

echo "staff admin reject tests passed\n";
