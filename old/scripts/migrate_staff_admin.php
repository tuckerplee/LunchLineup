<?php
require_once __DIR__ . '/../src/data.php';

function migrate_staff_admin(): void
{
    initDb();
    $db  = getDb();
    $col = staff_admin_column();
    if ($col === '') {
        return;
    }
    $sql = 'UPDATE staff s LEFT JOIN (
            SELECT DISTINCT user_id FROM user_company_roles
            WHERE role IN ("company_admin","super_admin")
        ) uca ON s.id = uca.user_id
        SET s.' . $col . ' = IF(uca.user_id IS NULL, 0, 1)';
    $db->exec($sql);
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    migrate_staff_admin();
    echo "Staff admin migration complete\n";
}
