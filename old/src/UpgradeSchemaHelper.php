<?php
declare(strict_types=1);

require_once __DIR__ . '/data/core.php';

final class UpgradeSchemaHelper
{
    public static function tableExists(PDO $db, string $table): bool
    {
        $stmt = $db->prepare('SHOW TABLES LIKE ?');
        $stmt->execute([$table]);

        return $stmt->fetchColumn() !== false;
    }

    public static function columnExists(PDO $db, string $table, string $column): bool
    {
        $config = getConfig();
        $stmt = $db->prepare(
            'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS '
            . 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
        );
        $stmt->execute([$config['dbname'], $table, $column]);

        return $stmt->fetchColumn() !== false;
    }

    public static function getColumnDefinition(PDO $db, string $table, string $column): ?array
    {
        $config = getConfig();
        $stmt = $db->prepare(
            'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, EXTRA '
            . 'FROM INFORMATION_SCHEMA.COLUMNS '
            . 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
        );
        $stmt->execute([$config['dbname'], $table, $column]);
        $result = $stmt->fetch(PDO::FETCH_ASSOC);

        return $result === false ? null : $result;
    }

    public static function indexExists(PDO $db, string $table, string $index): bool
    {
        $config = getConfig();
        $stmt = $db->prepare(
            'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS '
            . 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1'
        );
        $stmt->execute([$config['dbname'], $table, $index]);

        return $stmt->fetchColumn() !== false;
    }

    public static function foreignKeyExists(PDO $db, string $table, string $constraint): bool
    {
        $config = getConfig();
        $stmt = $db->prepare(
            'SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS '
            . 'WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1'
        );
        $stmt->execute([$config['dbname'], $table, $constraint]);

        return $stmt->fetchColumn() !== false;
    }
}
