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

require __DIR__ . '/../src/data/stores.php';
require __DIR__ . '/../src/data/roles.php';
require __DIR__ . '/../src/data/users.php';
require __DIR__ . '/../src/StaffService.php';
require __DIR__ . '/../src/UserService.php';

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
    $companyId = saveCompany(['name' => 'TestCo']);
    $storeA    = saveStore(['name' => 'A'], $companyId);
    $storeB    = saveStore(['name' => 'B'], $companyId);

    $service = new UserService();
    $userId  = $service->save([
        'email'       => 'u@example.com',
        'password'    => 'pw',
        'homeStoreId' => $storeA,
        'companyId'   => $companyId,
        'storeIds'    => [$storeA, $storeB],
        'roles'       => ['staff'],
    ]);

    $roles = fetch_user_store_roles($userId);
    assert_true(count($roles) === 4, 'assignRoles did not set roles');

    $service->assignRoles($userId, [$storeA], ['schedule']);
    $roles = fetch_user_store_roles($userId);
    assert_true(count($roles) === 2, 'assignRoles did not prune roles');

    $service->setAdmin($userId, $companyId, true);
    $rows = fetch_user_company_roles($userId);
    assert_true(count($rows) === 1, 'setAdmin did not assign role');
    $stmt = $db->prepare('SELECT isAdmin FROM staff WHERE id = ?');
    $stmt->execute([$userId]);
    assert_true((int) $stmt->fetchColumn() === 1, 'setAdmin did not flag staff');

    $service->setAdmin($userId, $companyId, false);
    $rows = fetch_user_company_roles($userId);
    assert_true($rows === [], 'setAdmin did not remove role');
    $stmt->execute([$userId]);
    assert_true((int) $stmt->fetchColumn() === 0, 'setAdmin did not clear flag');

    // Non-staff company user should not appear in staff table
    $userId2 = $service->save([
        'email'       => 'c@example.com',
        'password'    => 'pw',
        'homeStoreId' => $storeA,
        'companyId'   => $companyId,
        'storeIds'    => [$storeA],
        'roles'       => [],
    ]);
    $stmt->execute([$userId2]);
    assert_true($stmt->fetchColumn() === false, 'non-staff user was inserted into staff');
} finally {
    teardown_test_db($pdo);
}

echo "user service tests passed\n";
