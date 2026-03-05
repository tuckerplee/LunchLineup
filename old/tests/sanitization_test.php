<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/crypto.php';

$_ENV['APP_KEY'] = base64_encode(str_repeat('0', 32));

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

$db = new PDO('sqlite::memory:');
$db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$db->exec('CREATE TABLE staff (id INTEGER PRIMARY KEY, store_id INTEGER, company_id INTEGER, name TEXT, lunch_duration INTEGER, pos TEXT, tasks TEXT, isAdmin INTEGER)');
$db->exec(
    'CREATE TABLE chores (
        id INTEGER PRIMARY KEY,
        store_id INTEGER,
        name TEXT,
        description TEXT,
        instructions TEXT,
        is_active INTEGER,
        priority INTEGER,
        auto_assign_enabled INTEGER,
        frequency TEXT,
        recurrence_interval INTEGER,
        active_days TEXT,
        start_date TEXT,
        end_date TEXT,
        window_start TEXT,
        window_end TEXT,
        daypart TEXT,
        exclude_closer INTEGER,
        exclude_opener INTEGER,
        lead_time_minutes INTEGER,
        deadline_time TEXT,
        allow_multiple_assignees INTEGER,
        max_per_day INTEGER,
        max_per_shift INTEGER,
        max_per_employee_per_day INTEGER,
        min_staff_level INTEGER,
        estimated_duration_minutes INTEGER,
        location TEXT,
        equipment TEXT,
        assigned_to INTEGER,
        due_date TEXT,
        created_by INTEGER,
        created_at TEXT,
        updated_at TEXT
    )'
);
$db->exec('CREATE TABLE chore_allowed_positions (chore_id INTEGER, position TEXT)');
$db->exec('CREATE TABLE chore_excluded_positions (chore_id INTEGER, position TEXT)');
$db->exec('CREATE TABLE chore_required_skills (chore_id INTEGER, skill TEXT)');

function getDb(): PDO
{
    global $db;
    return $db;
}

require __DIR__ . '/util/db_table_has_column.php';

require __DIR__ . '/../src/data/staff.php';
require __DIR__ . '/../src/data/chores.php';

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
    $name = encryptField('<b>Alice</b>');
    $db->exec("INSERT INTO staff (id, store_id, company_id, name, lunch_duration, pos, tasks, isAdmin) VALUES (1, 1, 1, '$name', 30, '[1,2]', '[\"<i>clean</i>\",\"stock\"]', 0)");
    $staff = fetchStaff(1);
    assert_same('&lt;b&gt;Alice&lt;/b&gt;', $staff[0]['name']);
    assert_same(['&lt;i&gt;clean&lt;/i&gt;', 'stock'], $staff[0]['tasks']);

    $db->exec(
        "INSERT INTO chores (id, store_id, name, instructions, assigned_to) VALUES (
            1,
            1,
            '<b>Trash Duty</b>',
            '<em>Handle with care</em>',
            NULL
        )"
    );
    $chores = fetchChores(1);
    assert_same('&lt;b&gt;Trash Duty&lt;/b&gt;', $chores[0]['name']);
    assert_same('&lt;b&gt;Trash Duty&lt;/b&gt;', $chores[0]['description']);
    assert_same('&lt;em&gt;Handle with care&lt;/em&gt;', $chores[0]['instructions']);
} finally {
    $db = null;
}

echo "Sanitization tests passed\n";
