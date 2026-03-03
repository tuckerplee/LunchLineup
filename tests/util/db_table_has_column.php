<?php

declare(strict_types=1);

function db_table_has_column(string $table, string $column): bool
{
    static $cache = [];
    $key = $table . '.' . $column;
    if (array_key_exists($key, $cache)) {
        return $cache[$key];
    }
    $db = getDb();
    if (!preg_match('/^[A-Za-z0-9_]+$/', $table)) {
        $cache[$key] = false;
        return false;
    }
    $safeTable = str_replace("'", "''", $table);
    $stmt      = $db->query("PRAGMA table_info('{$safeTable}')");
    if ($stmt === false) {
        $cache[$key] = false;
        return false;
    }
    $exists = false;
    while (($row = $stmt->fetch(PDO::FETCH_ASSOC)) !== false) {
        if (isset($row['name']) && $row['name'] === $column) {
            $exists = true;
            break;
        }
    }
    $stmt->closeCursor();
    $cache[$key] = $exists;
    return $exists;
}
