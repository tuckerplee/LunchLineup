<?php
require_once __DIR__ . '/../src/data.php';

function migrate_staff_to_users(string $defaultPassword = 'changeme'): void
{
    $db = getDb();
    $staff = $db->query('SELECT id, name FROM staff')->fetchAll(PDO::FETCH_ASSOC);
    $hash = password_hash($defaultPassword, PASSWORD_DEFAULT);
    $companyId = (int) $db->query('SELECT id FROM companies LIMIT 1')->fetchColumn();
    $usernameHashColumns = getUserUsernameHashColumns();
    $usernameColumn      = getUserUsernameColumn();
    $columns          = ['id', $usernameColumn];
    foreach ($usernameHashColumns as $column) {
        $columns[] = $column;
    }
    $columns[] = 'password_hash';
    $columns[] = 'company_id';
    $placeholders = implode(', ', array_fill(0, count($columns), '?'));
    $updates      = [$usernameColumn . ' = VALUES(' . $usernameColumn . ')', 'company_id = VALUES(company_id)'];
    foreach ($usernameHashColumns as $column) {
        $updates[] = $column . ' = VALUES(' . $column . ')';
    }
    $sql = 'INSERT INTO users (' . implode(', ', $columns) . ') VALUES (' . $placeholders
        . ') ON DUPLICATE KEY UPDATE ' . implode(', ', $updates);
    $insert = $db->prepare($sql);
    foreach ($staff as $person) {
        $slug = strtolower(preg_replace('/[^a-z0-9]+/', '.', $person['name']));
        $username = $slug;
        $usernameHash = usernameHash($username);
        $params    = [$person['id'], encryptField($username)];
        foreach ($usernameHashColumns as $column) {
            $params[] = $usernameHash;
        }
        $params[] = $hash;
        $params[] = $companyId;
        $insert->execute($params);
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    $password = $argv[1] ?? 'changeme';
    migrate_staff_to_users($password);
    echo "Users migrated\n";
}
