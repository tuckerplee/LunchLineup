<?php
require_once __DIR__ . '/../src/data.php';

function migrateCompanies(?int $adminUserId = null): void
{
    initDb();
    $db = getDb();

    if ((int) $db->query('SELECT COUNT(*) FROM companies')->fetchColumn() === 0) {
        $db->exec("INSERT INTO companies (name) VALUES ('Main Company')");
    }
    $companyId = (int) $db->query('SELECT id FROM companies LIMIT 1')->fetchColumn();

    $stmt = $db->prepare('UPDATE stores SET company_id = ? WHERE company_id IS NULL');
    $stmt->execute([$companyId]);
    $stmt = $db->prepare('UPDATE users SET company_id = ? WHERE company_id IS NULL');
    $stmt->execute([$companyId]);

    if ($adminUserId === null) {
        $adminUserId = (int) $db->query('SELECT id FROM users ORDER BY id LIMIT 1')->fetchColumn();
    } else {
        $check = $db->prepare('SELECT 1 FROM users WHERE id = ?');
        $check->execute([$adminUserId]);
        if ($check->fetchColumn() === false) {
            $adminUserId = 0;
        }
    }

    if ($adminUserId > 0) {
        assign_user_company_role($adminUserId, $companyId, 'company_admin');
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    $userId = $argv[1] ?? null;
    migrateCompanies($userId !== null ? (int) $userId : null);
    echo "Company migration complete\n";
}
