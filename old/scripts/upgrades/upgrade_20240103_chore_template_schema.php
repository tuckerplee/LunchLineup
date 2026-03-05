<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20240103ChoreTemplateSchema
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        $db      = getDb();

        if (!UpgradeSchemaHelper::tableExists($db, 'chores')) {
            self::log($logger, 'Chores table not found; skipping chore template migration.');

            return;
        }

        self::log($logger, 'Upgrading chore metadata columns.');

        self::ensureColumns($db, $logger);
        self::normalizeData($db, $logger);
        self::dropDeprecatedColumns($db, $logger);
        self::ensureIndexes($db, $logger);
        self::ensureForeignKeys($db, $logger);
        self::removeLegacyLinkTables($db, $logger);
    }

    private static function resolveLogger(?callable $logger): callable
    {
        if ($logger !== null) {
            return $logger;
        }

        return static function (string $message): void {
            echo $message . PHP_EOL;
        };
    }

    private static function log(callable $logger, string $message): void
    {
        $logger($message);
    }

    private static function ensureColumns(PDO $db, callable $logger): void
    {
        $columns = [
            'name' => "ADD COLUMN `name` VARCHAR(255) NOT NULL DEFAULT '' AFTER `store_id`",
            'instructions' => 'ADD COLUMN `instructions` TEXT NULL AFTER `name`',
            'is_active' => 'ADD COLUMN `is_active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `instructions`',
            'priority' => 'ADD COLUMN `priority` INT NOT NULL DEFAULT 0 AFTER `is_active`',
            'auto_assign_enabled' => 'ADD COLUMN `auto_assign_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `priority`',
            'frequency' => "ADD COLUMN `frequency` ENUM('once','daily','weekly','monthly','per_shift') NOT NULL DEFAULT 'daily' AFTER `auto_assign_enabled`",
            'recurrence_interval' => 'ADD COLUMN `recurrence_interval` SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER `frequency`',
            'active_days' => "ADD COLUMN `active_days` SET('sun','mon','tue','wed','thu','fri','sat') DEFAULT NULL AFTER `recurrence_interval`",
            'window_start' => 'ADD COLUMN `window_start` TIME DEFAULT NULL AFTER `active_days`',
            'window_end' => 'ADD COLUMN `window_end` TIME DEFAULT NULL AFTER `window_start`',
            'daypart' => "ADD COLUMN `daypart` ENUM('open','mid','close','custom') DEFAULT NULL AFTER `window_end`",
            'exclude_closer' => 'ADD COLUMN `exclude_closer` TINYINT(1) NOT NULL DEFAULT 0 AFTER `daypart`',
            'exclude_opener' => 'ADD COLUMN `exclude_opener` TINYINT(1) NOT NULL DEFAULT 0 AFTER `exclude_closer`',
            'lead_time_minutes' => 'ADD COLUMN `lead_time_minutes` SMALLINT UNSIGNED DEFAULT NULL AFTER `exclude_opener`',
            'deadline_time' => 'ADD COLUMN `deadline_time` TIME DEFAULT NULL AFTER `lead_time_minutes`',
            'allow_multiple_assignees' => 'ADD COLUMN `allow_multiple_assignees` TINYINT(1) NOT NULL DEFAULT 0 AFTER `deadline_time`',
            'max_per_day' => 'ADD COLUMN `max_per_day` SMALLINT UNSIGNED DEFAULT NULL AFTER `allow_multiple_assignees`',
            'max_per_shift' => 'ADD COLUMN `max_per_shift` SMALLINT UNSIGNED DEFAULT NULL AFTER `max_per_day`',
            'max_per_employee_per_day' => 'ADD COLUMN `max_per_employee_per_day` SMALLINT UNSIGNED DEFAULT NULL AFTER `max_per_shift`',
            'min_staff_level' => 'ADD COLUMN `min_staff_level` SMALLINT UNSIGNED DEFAULT NULL AFTER `max_per_employee_per_day`',
            'estimated_duration_minutes' => 'ADD COLUMN `estimated_duration_minutes` SMALLINT UNSIGNED DEFAULT NULL AFTER `min_staff_level`',
            'created_by' => 'ADD COLUMN `created_by` INT UNSIGNED DEFAULT NULL AFTER `estimated_duration_minutes`',
            'created_at' => 'ADD COLUMN `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER `created_by`',
            'updated_at' => 'ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`',
            'assigned_to' => 'ADD COLUMN `assigned_to` INT UNSIGNED NULL AFTER `updated_at`',
        ];

        $alterParts = [];
        foreach ($columns as $column => $definition) {
            if (!UpgradeSchemaHelper::columnExists($db, 'chores', $column)) {
                $alterParts[] = $definition;
            }
        }

        if ($alterParts !== []) {
            self::log($logger, 'Adding missing chore columns.');
            $db->exec('ALTER TABLE `chores` ' . implode(', ', $alterParts));
        }
    }

    private static function normalizeData(PDO $db, callable $logger): void
    {
        if (UpgradeSchemaHelper::columnExists($db, 'chores', 'description')) {
            self::log($logger, 'Populating chore names from legacy description column.');
            $db->exec(
                "UPDATE `chores` SET `name` = LEFT(COALESCE(`description`, ''), 255)"
                . " WHERE (`name` = '' OR `name` IS NULL) AND `description` IS NOT NULL"
            );
        }
    }

    private static function dropDeprecatedColumns(PDO $db, callable $logger): void
    {
        $deprecated = ['description', 'start_date', 'end_date', 'location', 'equipment', 'due_date'];
        $drops      = [];
        foreach ($deprecated as $column) {
            if (UpgradeSchemaHelper::columnExists($db, 'chores', $column)) {
                $drops[] = 'DROP COLUMN `' . $column . '`';
            }
        }

        if ($drops !== []) {
            self::log($logger, 'Removing deprecated chore columns.');
            $db->exec('ALTER TABLE `chores` ' . implode(', ', $drops));
        }
    }

    private static function ensureIndexes(PDO $db, callable $logger): void
    {
        $indexes = [
            'idx_chores_store' => '`store_id`',
            'idx_chores_assigned_to' => '`assigned_to`',
            'idx_chores_active' => '`store_id`, `is_active`',
            'idx_chores_frequency' => '`frequency`',
        ];

        foreach ($indexes as $name => $definition) {
            if (!UpgradeSchemaHelper::indexExists($db, 'chores', $name)) {
                self::log($logger, 'Adding ' . $name . ' index.');
                $db->exec('ALTER TABLE `chores` ADD INDEX `' . $name . '` (' . $definition . ')');
            }
        }
    }

    private static function ensureForeignKeys(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'chores', 'fk_chores_store')
            && UpgradeSchemaHelper::tableExists($db, 'stores')
        ) {
            self::log($logger, 'Adding fk_chores_store foreign key.');
            $db->exec(
                'ALTER TABLE `chores`'
                . ' ADD CONSTRAINT `fk_chores_store`'
                . ' FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`)' . ' ON UPDATE CASCADE ON DELETE RESTRICT'
            );
        }

        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'chores', 'fk_chores_assigned')
            && UpgradeSchemaHelper::tableExists($db, 'staff')
        ) {
            self::log($logger, 'Adding fk_chores_assigned foreign key.');
            $db->exec(
                'ALTER TABLE `chores`'
                . ' ADD CONSTRAINT `fk_chores_assigned`'
                . ' FOREIGN KEY (`assigned_to`) REFERENCES `staff`(`id`)' . ' ON UPDATE CASCADE ON DELETE SET NULL'
            );
        }

        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'chores', 'fk_chores_created_by')
            && UpgradeSchemaHelper::tableExists($db, 'users')
        ) {
            self::log($logger, 'Adding fk_chores_created_by foreign key.');
            $db->exec(
                'ALTER TABLE `chores`'
                . ' ADD CONSTRAINT `fk_chores_created_by`'
                . ' FOREIGN KEY (`created_by`) REFERENCES `users`(`id`)' . ' ON UPDATE CASCADE ON DELETE SET NULL'
            );
        }
    }

    private static function removeLegacyLinkTables(PDO $db, callable $logger): void
    {
        foreach (['chore_allowed_positions', 'chore_excluded_positions', 'chore_required_skills'] as $table) {
            if (UpgradeSchemaHelper::tableExists($db, $table)) {
                self::log($logger, 'Dropping legacy table ' . $table . '.');
                $db->exec('DROP TABLE `' . $table . '`');
            }
        }
    }
}
