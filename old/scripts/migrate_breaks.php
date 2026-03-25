<?php
require_once __DIR__ . '/../src/data.php';

function migrateBreaks(): void
{
    initDb();
    $db = getDb();

    // Add breaks column if it doesn't exist
    $cols = $db->query("SHOW COLUMNS FROM shifts LIKE 'breaks'")->fetchAll();
    if (count($cols) === 0) {
        $db->exec("ALTER TABLE shifts ADD COLUMN breaks JSON NULL");
    }

    // Populate breaks column from existing break fields
    $rows = $db->query('SELECT id, break1, break1_duration, lunch, lunch_duration, break2, break2_duration FROM shifts')->fetchAll(PDO::FETCH_ASSOC);
    $update = $db->prepare('UPDATE shifts SET breaks = ? WHERE id = ?');
    foreach ($rows as $row) {
        $breaks = [];
        if (($row['break1'] ?? '') !== '' || ($row['break1_duration'] ?? '') !== '') {
            $breaks[] = ['start' => $row['break1'], 'duration' => (int) $row['break1_duration']];
        }
        if (($row['lunch'] ?? '') !== '' || ($row['lunch_duration'] ?? '') !== '') {
            $breaks[] = ['start' => $row['lunch'], 'duration' => (int) $row['lunch_duration']];
        }
        if (($row['break2'] ?? '') !== '' || ($row['break2_duration'] ?? '') !== '') {
            $breaks[] = ['start' => $row['break2'], 'duration' => (int) $row['break2_duration']];
        }
        $update->execute([json_encode($breaks), $row['id']]);
    }
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    migrateBreaks();
    echo "Break migration complete\n";
}
