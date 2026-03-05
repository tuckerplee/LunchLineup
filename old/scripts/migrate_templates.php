<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/data.php';

function migrateTemplatesTableExists(PDO $db, string $table): bool
{
    $stmt = $db->prepare('SHOW TABLES LIKE ?');
    $stmt->execute([$table]);

    return $stmt->fetchColumn() !== false;
}

function migrateTemplates(): void
{
    $db = getDb();
    if (!migrateTemplatesTableExists($db, 'break_templates')) {
        initDb();
        $db = getDb();
        if (!migrateTemplatesTableExists($db, 'break_templates')) {
            return;
        }
    }

    $defaultStmt = $db->query(
        'SELECT break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration FROM break_templates WHERE company_id IS NULL LIMIT 1'
    );
    $default = $defaultStmt->fetch(PDO::FETCH_ASSOC) ?: [
        'break1_offset' => 2,
        'break1_duration' => 10,
        'lunch_offset' => 4,
        'lunch_duration' => 60,
        'break2_offset' => 2,
        'break2_duration' => 10,
    ];

    $companies = $db->query('SELECT id FROM companies')->fetchAll(PDO::FETCH_COLUMN);
    $insert = $db->prepare(
        'INSERT IGNORE INTO break_templates (company_id, name, break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration) VALUES (?, "Default", ?, ?, ?, ?, ?, ?)'
    );

    foreach ($companies as $cid) {
        $insert->execute([
            $cid,
            $default['break1_offset'],
            $default['break1_duration'],
            $default['lunch_offset'],
            $default['lunch_duration'],
            $default['break2_offset'],
            $default['break2_duration'],
        ]);
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    migrateTemplates();
    echo "Template migration complete\n";
}
