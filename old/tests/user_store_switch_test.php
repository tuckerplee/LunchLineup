<?php

declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$pdo = create_test_db();

class PdoProxy
{
    private PDO $pdo;

    public function __construct(PDO $pdo)
    {
        $this->pdo = $pdo;
    }

    public function prepare(string $statement, array $options = []): PDOStatement
    {
        if (str_contains($statement, 'ON DUPLICATE KEY UPDATE')) {
            $statement = str_replace('ON DUPLICATE KEY UPDATE', 'ON CONFLICT(id) DO UPDATE SET', $statement);
            $statement = preg_replace('/= VALUES\(([^)]+)\)/', '= excluded.$1', $statement);
        }
        return $this->pdo->prepare($statement, $options);
    }

    public function __call(string $name, array $arguments)
    {
        return $this->pdo->$name(...$arguments);
    }
}

$db = new PdoProxy($pdo);
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

function getDb()
{
    global $db;
    return $db;
}

require __DIR__ . '/util/db_table_has_column.php';

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    $db = getDb();
    $stmt = $db->prepare(
        'INSERT INTO audit_logs (user_id, company_id, action, entity, entity_id) VALUES (NULL, ?, ?, ?, ?)'
    );
    $stmt->execute([$companyId ?? 1, $action, $entity, $entityId]);
}

require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/data/roles.php';
require __DIR__ . '/../src/data/users.php';
putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));
require __DIR__ . '/../src/StaffService.php';
require __DIR__ . '/../src/UserService.php';

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
    $companyId = saveCompany(['name' => 'SwitchCo']);
    $storeAId  = saveStore(['name' => 'Store A'], $companyId);
    $storeBId  = saveStore(['name' => 'Store B'], $companyId);

    $service = new UserService();
    $userId  = $service->save([
        'email'       => 'user@example.com',
        'password'    => 'secret',
        'homeStoreId' => $storeAId,
        'companyId'   => $companyId,
    ]);

    $roles = fetch_user_store_roles($userId);
    assert_same($storeAId, (int) $roles[0]['store_id'], 'User not assigned to store A');

    $service->save([
        'id'          => $userId,
        'email'       => 'user@example.com',
        'homeStoreId' => $storeBId,
        'companyId'   => $companyId,
    ]);

    $roles = fetch_user_store_roles($userId);
    assert_same(1, count($roles), 'Unexpected number of store roles');
    assert_same($storeBId, (int) $roles[0]['store_id'], 'User not switched to store B');

    $users = fetchUsers();
    $user  = array_values(array_filter($users, fn ($u) => (int) $u['id'] === $userId))[0];
    assert_same($storeBId, $user['homeStoreId'], 'homeStoreId not updated');
    assert_true(in_array($storeBId, $user['storeIds'], true), 'Store B not listed in storeIds');
    assert_true(! in_array($storeAId, $user['storeIds'], true), 'Store A still listed in storeIds');
    assert_same([], $user['roles'], 'Unexpected user roles');
} finally {
    teardown_test_db($pdo);
}

echo "user store switch tests passed\n";
