<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

$db  = create_test_db();
$ids = seed_sample_data($db);

function getDb(): PDO { global $db; return $db; }
function sanitizeString(string $v): string { return $v; }
require __DIR__ . '/util/db_table_has_column.php';

require __DIR__ . '/../src/data/staff.php';
require __DIR__ . '/../src/schedule_parser.php';

function assert_eq($expected, $actual, string $msg = ''): void {
    if ($expected !== $actual) {
        echo "Assertion failed: $msg\n";
        var_export($actual);
        echo "\n";
        exit(1);
    }
}

// Add admin staff to company 1
$db->exec("INSERT INTO staff (store_id, company_id, name, lunch_duration, isAdmin) VALUES ({$ids['store_id']}, {$ids['company_id']}, 'Bob', 30, 1)");

// Add staff for a different company
$db->exec("INSERT INTO companies (name) VALUES ('Other Co')");
$company2 = (int) $db->lastInsertId();
$db->exec("INSERT INTO stores (company_id, name, location) VALUES ($company2, 'Second', 'Loc')");
$store2 = (int) $db->lastInsertId();
$db->exec("INSERT INTO staff (store_id, company_id, name, lunch_duration, isAdmin) VALUES ($store2, $company2, 'Charlie', 30, 0)");

$raw = "Sunday 05/12/2024\n" .
       "Cashier\nSmith, Alice\n9:00 AM - 5:00 PM\n" .
       "Cashier\nJones, Bob\n9:00 AM - 5:00 PM\n" .
       "Cashier\nBrown, Charlie\n9:00 AM - 5:00 PM\n";

$result = parse_schedule_text($raw, $ids['company_id'], $ids['store_id']);
$employees = $result['schedule']['2024-05-12']['employees'];
assert_eq(3, count($employees), 'employee count');
$map = [];
foreach ($employees as $e) {
    $map[$e['name']] = $e['id'];
}
assert_eq($ids['staff_id'], $map['Alice'] ?? null, 'Alice recognised');
assert_eq(null, $map['Bob'] ?? null, 'admin excluded');
assert_eq(null, $map['Charlie'] ?? null, 'other company excluded');

teardown_test_db($db);

echo "schedule parser company filter tests passed\n";
