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

function getDb()
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
require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/data/users.php';

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function assert_true(bool $cond, string $msg): void
{
    if (! $cond) {
        echo $msg . "\n";
        exit(1);
    }
}

try {
    $companyId = saveCompany(['name' => 'Co']);
    $storeA    = saveStore(['name' => 'A'], $companyId);
    $storeB    = saveStore(['name' => 'B'], $companyId);

    $userId = saveUser([
        'email'       => 'u@example.com',
        'password'    => 'pw',
        'homeStoreId' => $storeA,
        'companyId'   => $companyId,
        'name'        => 'Test',
    ]);

    sync_user_roles($userId, [$storeA, $storeB], ['staff']);
    $roles = fetch_user_store_roles($userId);
    assert_true(count($roles) === 4, 'sync_user_roles did not assign roles');

    sync_user_roles($userId, [$storeA], ['schedule']);
    $roles = fetch_user_store_roles($userId);
    assert_true(count($roles) === 2, 'sync_user_roles did not remove roles');
} finally {
    teardown_test_db($pdo);
}

echo "sync_user_roles tests passed\n";
