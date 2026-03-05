<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

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
require __DIR__ . '/../src/data/schedule.php';

try {
    $db->exec('CREATE TABLE shifts (id INTEGER PRIMARY KEY AUTOINCREMENT, staff_id INTEGER, date TEXT, shift_hours TEXT, pos TEXT, break1 TEXT, break1_duration TEXT, lunch TEXT, lunch_duration TEXT, break2 TEXT, break2_duration TEXT, breaks TEXT, tasks TEXT, sign_off TEXT, store_id INTEGER)');
    $db->exec("INSERT INTO companies (name) VALUES ('Acme')");
    $companyId = (int) $db->lastInsertId();
    $db->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main')");
    $storeId = (int) $db->lastInsertId();
    $db->prepare('INSERT INTO staff (id, store_id, company_id, name, isAdmin) VALUES (?,?,?,?,1)')
       ->execute([1, $storeId, $companyId, encryptField('Admin')]);

    $schedule = [
        '2024-05-12' => [
            'employees' => [
                ['id' => 1, 'storeId' => $storeId, 'name' => 'Admin', 'shift' => '9-5']
            ]
        ]
    ];

    try {
        saveSchedule($schedule);
        echo "Expected exception not thrown\n";
        exit(1);
    } catch (InvalidArgumentException $e) {
        // expected
    }

    $count = (int) $db->query('SELECT COUNT(*) FROM shifts')->fetchColumn();
    if ($count !== 0) {
        echo "Shifts table should be empty, found $count\n";
        exit(1);
    }
} finally {
    teardown_test_db($db);
}

echo "schedule admin reject tests passed\n";
