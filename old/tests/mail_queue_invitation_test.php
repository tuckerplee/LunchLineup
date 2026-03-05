<?php

declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

$db->exec(
    'CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        company_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )'
);

$db->exec(
    'CREATE TABLE mail_queue (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        email TEXT NOT NULL,
        store_id INTEGER NOT NULL,
        role TEXT NOT NULL,
        template TEXT NOT NULL DEFAULT "invitation.txt",
        status TEXT NOT NULL DEFAULT "pending",
        created_at TEXT DEFAULT CURRENT_TIMESTAMP,
        updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (store_id) REFERENCES stores(id)
            ON UPDATE CASCADE ON DELETE RESTRICT
    )'
);

function getDb(): PDO
{
    global $db;
    return $db;
}

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    $db = getDb();
    $stmt = $db->prepare(
        'INSERT INTO audit_logs (user_id, company_id, action, entity, entity_id) VALUES (NULL, ?, ?, ?, ?)'
    );
    $stmt->execute([$companyId ?? 1, $action, $entity, $entityId]);
}

require __DIR__ . '/../src/data/users.php';

function assert_true(bool $condition, string $message): void
{
    if (! $condition) {
        echo $message . "\n";
        exit(1);
    }
}

function assert_same(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        echo $message . "\n";
        exit(1);
    }
}

try {
    $ids       = seed_sample_data($db);
    $companyId = $ids['company_id'];
    $storeId   = $ids['store_id'];

    queueInvitation('invitee@example.com', $storeId, 'manager');

    $queue = fetch_mail_queue($companyId);
    assert_same(1, count($queue), 'Queue entry not created');
    $entry = $queue[0];
    assert_same('invitee@example.com', $entry['email'], 'Email mismatch');
    assert_same($storeId, (int) $entry['store_id'], 'Store ID mismatch');
    assert_same('Main Store', $entry['store_name'], 'Store name mismatch');
    assert_same('manager', $entry['role'], 'Role mismatch');
    assert_same('pending', $entry['status'], 'Initial status incorrect');

    $count = (int) $db->query(
        "SELECT COUNT(*) FROM audit_logs WHERE action = 'invite' AND entity = 'invitation'"
    )->fetchColumn();
    assert_same(1, $count, 'Invitation not logged');

    $id = (int) $entry['id'];
    update_mail_queue_status($id, 'sent');
    update_mail_queue_status($id, 'canceled');

    $queue = fetch_mail_queue($companyId);
    $entry = array_values(array_filter($queue, fn ($q) => (int) $q['id'] === $id))[0];
    assert_same('canceled', $entry['status'], 'Status transition not persisted');

    $count = (int) $db->query(
        "SELECT COUNT(*) FROM audit_logs WHERE entity = 'mail_queue' AND entity_id = $id AND action = 'update'"
    )->fetchColumn();
    assert_same(2, $count, 'Status updates not logged');
} finally {
    teardown_test_db($db);
}

echo "mail queue invitation tests passed\n";
