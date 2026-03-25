<?php

declare(strict_types=1);

require_once __DIR__ . '/../src/crypto.php';
require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/data/roles.php';
require __DIR__ . '/../src/data/users.php';

$pdo = new PDO('sqlite::memory:');
$pdo->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
$pdo->exec('PRAGMA foreign_keys = ON');

$schema = [
    'CREATE TABLE companies (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL
    )',
    'CREATE TABLE stores (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL,
        name TEXT NOT NULL
    )',
    'CREATE TABLE users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        company_id INTEGER NOT NULL DEFAULT 1,
        email TEXT NOT NULL,
        emailHash TEXT NOT NULL UNIQUE,
        email_hash TEXT NOT NULL UNIQUE,
        password_hash TEXT NOT NULL,
        locked_until TEXT,
        home_store_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP
    )',
    'CREATE TABLE staff (
        id INTEGER PRIMARY KEY,
        store_id INTEGER,
        company_id INTEGER,
        name TEXT NOT NULL,
        isAdmin INTEGER DEFAULT 0
    )',
    'CREATE TABLE user_company_roles (
        user_id INTEGER NOT NULL,
        company_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (user_id, company_id, role)
    )',
    'CREATE TABLE user_store_roles (
        user_id INTEGER NOT NULL,
        store_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        PRIMARY KEY (user_id, store_id, role)
    )'
];

foreach ($schema as $sql) {
    $pdo->exec($sql);
}

function getDb(): PDO
{
    global $pdo;
    return $pdo;
}

require __DIR__ . '/util/db_table_has_column.php';

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    // no-op for tests
}

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

function assert_same(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        echo $message . "\n";
        var_export($actual);
        echo "\n";
        exit(1);
    }
}

try {
    $pdo->exec("INSERT INTO companies (name) VALUES ('DualHash Co')");
    $companyId = (int) $pdo->lastInsertId();
    $pdo->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main Store')");
    $storeId = (int) $pdo->lastInsertId();

    $userId = saveUser([
        'email'       => 'user@example.com',
        'password'    => 'secret',
        'homeStoreId' => $storeId,
        'companyId'   => $companyId,
        'isStaff'     => false,
        'isAdmin'     => false,
    ]);

    $stmt = $pdo->prepare('SELECT emailHash, email_hash FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $expectedHash = emailHash('user@example.com');
    assert_same($expectedHash, $row['emailHash'] ?? null, 'emailHash column not populated on insert');
    assert_same($expectedHash, $row['email_hash'] ?? null, 'email_hash column not populated on insert');

    saveUser([
        'id'          => $userId,
        'email'       => 'updated@example.com',
        'homeStoreId' => $storeId,
        'companyId'   => $companyId,
    ]);

    $stmt->execute([$userId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $updatedHash = emailHash('updated@example.com');
    assert_same($updatedHash, $row['emailHash'] ?? null, 'emailHash column not updated');
    assert_same($updatedHash, $row['email_hash'] ?? null, 'email_hash column not updated');

    $inviteeId = find_or_create_user('invitee@example.com');
    $stmt->execute([$inviteeId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    $inviteeHash = emailHash('invitee@example.com');
    assert_same($inviteeHash, $row['emailHash'] ?? null, 'emailHash column not set for background user');
    assert_same($inviteeHash, $row['email_hash'] ?? null, 'email_hash column not set for background user');
} finally {
    $pdo = null;
}

echo "user email hash column tests passed\n";
