<?php
require_once __DIR__ . '/../src/data.php';

function seed_staff_from_users(): void
{
    initDb();
    $db = getDb();

    $usernameColumn = getUserUsernameColumn();
    $cols = ['id', $usernameColumn, 'home_store_id'];
    if (db_table_has_column('users', 'company_id')) {
        $cols[] = 'company_id';
    }
    $sql = 'SELECT ' . implode(', ', $cols) . ' FROM users';
    $users = $db->query($sql)->fetchAll(PDO::FETCH_ASSOC);

    $check = $db->prepare('SELECT 1 FROM staff WHERE id = ?');
    foreach ($users as $user) {
        $check->execute([$user['id']]);
        if ($check->fetchColumn() !== false) {
            continue;
        }
        $rawUsername = $user[$usernameColumn] ?? '';
        $username = $rawUsername !== '' ? decryptField((string) $rawUsername) : '';
        $name = $username !== '' ? $username : 'User ' . $user['id'];
        $staff = [
            'id' => $user['id'],
            'name' => $name,
            'storeId' => $user['home_store_id'] ?? null,
        ];
        if (isset($user['company_id'])) {
            $staff['companyId'] = $user['company_id'];
        }
        save_staff_member($staff);
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    seed_staff_from_users();
    echo "Staff seeding complete\n";
}
