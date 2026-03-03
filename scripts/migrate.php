<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/data.php';
require_once __DIR__ . '/migrate_templates.php';

function tableExists(PDO $db, string $table): bool
{
    $stmt = $db->prepare('SHOW TABLES LIKE ?');
    $stmt->execute([$table]);

    return $stmt->fetchColumn() !== false;
}

function columnExists(PDO $db, string $table, string $column): bool
{
    $config = getConfig();
    $stmt = $db->prepare(
        'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS '
        . 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? LIMIT 1'
    );
    $stmt->execute([$config['dbname'], $table, $column]);

    return $stmt->fetchColumn() !== false;
}

function indexExists(PDO $db, string $table, string $index): bool
{
    $config = getConfig();
    $stmt = $db->prepare(
        'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS '
        . 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = ? LIMIT 1'
    );
    $stmt->execute([$config['dbname'], $table, $index]);

    return $stmt->fetchColumn() !== false;
}

function foreignKeyExists(PDO $db, string $table, string $constraint): bool
{
    $config = getConfig();
    $stmt = $db->prepare(
        'SELECT 1 FROM INFORMATION_SCHEMA.REFERENTIAL_CONSTRAINTS '
        . 'WHERE CONSTRAINT_SCHEMA = ? AND TABLE_NAME = ? AND CONSTRAINT_NAME = ? LIMIT 1'
    );
    $stmt->execute([$config['dbname'], $table, $constraint]);

    return $stmt->fetchColumn() !== false;
}

function ensureChoreTemplateSchema(PDO $db): void
{
    if (!tableExists($db, 'chores')) {
        return;
    }

    if (!columnExists($db, 'chores', 'name')) {
        $db->exec(
            "ALTER TABLE `chores`
                ADD COLUMN `name` VARCHAR(255) NOT NULL DEFAULT '' AFTER `store_id`,
                ADD COLUMN `instructions` TEXT NULL AFTER `name`,
                ADD COLUMN `is_active` TINYINT(1) NOT NULL DEFAULT 1 AFTER `instructions`,
                ADD COLUMN `priority` INT NOT NULL DEFAULT 0 AFTER `is_active`,
                ADD COLUMN `auto_assign_enabled` TINYINT(1) NOT NULL DEFAULT 1 AFTER `priority`,
                ADD COLUMN `frequency` ENUM('once','daily','weekly','monthly','per_shift') NOT NULL DEFAULT 'daily' AFTER `auto_assign_enabled`,
                ADD COLUMN `recurrence_interval` SMALLINT UNSIGNED NOT NULL DEFAULT 1 AFTER `frequency`,
                ADD COLUMN `active_days` SET('sun','mon','tue','wed','thu','fri','sat') DEFAULT NULL AFTER `recurrence_interval`,
                ADD COLUMN `window_start` TIME DEFAULT NULL AFTER `active_days`,
                ADD COLUMN `window_end` TIME DEFAULT NULL AFTER `window_start`,
                ADD COLUMN `daypart` ENUM('open','mid','close','custom') DEFAULT NULL AFTER `window_end`,
                ADD COLUMN `exclude_closer` TINYINT(1) NOT NULL DEFAULT 0 AFTER `daypart`,
                ADD COLUMN `exclude_opener` TINYINT(1) NOT NULL DEFAULT 0 AFTER `exclude_closer`,
                ADD COLUMN `lead_time_minutes` SMALLINT UNSIGNED DEFAULT NULL AFTER `exclude_opener`,
                ADD COLUMN `deadline_time` TIME DEFAULT NULL AFTER `lead_time_minutes`,
                ADD COLUMN `allow_multiple_assignees` TINYINT(1) NOT NULL DEFAULT 0 AFTER `deadline_time`,
                ADD COLUMN `max_per_day` SMALLINT UNSIGNED DEFAULT NULL AFTER `allow_multiple_assignees`,
                ADD COLUMN `max_per_shift` SMALLINT UNSIGNED DEFAULT NULL AFTER `max_per_day`,
                ADD COLUMN `max_per_employee_per_day` SMALLINT UNSIGNED DEFAULT NULL AFTER `max_per_shift`,
                ADD COLUMN `min_staff_level` SMALLINT UNSIGNED DEFAULT NULL AFTER `max_per_employee_per_day`,
                ADD COLUMN `estimated_duration_minutes` SMALLINT UNSIGNED DEFAULT NULL AFTER `min_staff_level`,
                ADD COLUMN `created_by` INT UNSIGNED DEFAULT NULL AFTER `estimated_duration_minutes`,
                ADD COLUMN `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP AFTER `created_by`,
                ADD COLUMN `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `created_at`,
                MODIFY `assigned_to` INT UNSIGNED NULL"
        );
    }

    if (columnExists($db, 'chores', 'description')) {
        $db->exec(
            "UPDATE `chores`
                SET `name` = LEFT(COALESCE(`description`, ''), 255)
              WHERE (`name` = '' OR `name` IS NULL) AND `description` IS NOT NULL"
        );
    }

    foreach (['description', 'start_date', 'end_date', 'location', 'equipment', 'due_date'] as $deprecatedColumn) {
        if (columnExists($db, 'chores', $deprecatedColumn)) {
            $sql = sprintf('ALTER TABLE `chores` DROP COLUMN `%s`', $deprecatedColumn);
            $db->exec($sql);
        }
    }

    if (!foreignKeyExists($db, 'chores', 'fk_chores_created_by') && columnExists($db, 'chores', 'created_by')) {
        if (tableExists($db, 'users')) {
            $db->exec(
                'ALTER TABLE `chores`
                    ADD CONSTRAINT `fk_chores_created_by`
                    FOREIGN KEY (`created_by`) REFERENCES `users`(`id`)
                    ON UPDATE CASCADE ON DELETE SET NULL'
            );
        }
    }

    if (!indexExists($db, 'chores', 'idx_chores_active') && columnExists($db, 'chores', 'is_active')) {
        $db->exec('ALTER TABLE `chores` ADD INDEX `idx_chores_active` (`store_id`, `is_active`)');
    }

    if (!indexExists($db, 'chores', 'idx_chores_frequency') && columnExists($db, 'chores', 'frequency')) {
        $db->exec('ALTER TABLE `chores` ADD INDEX `idx_chores_frequency` (`frequency`)');
    }

    if (!columnExists($db, 'chores', 'exclude_opener')) {
        $db->exec(
            "ALTER TABLE `chores`
                ADD COLUMN `exclude_opener` TINYINT(1) NOT NULL DEFAULT 0 AFTER `exclude_closer`"
        );
    }

    foreach (['chore_allowed_positions', 'chore_excluded_positions', 'chore_required_skills'] as $table) {
        if (tableExists($db, $table)) {
            $db->exec('DROP TABLE `' . $table . '`');
        }
    }
}

function ensureBaseSchema(PDO $db): void
{
    if (!tableExists($db, 'companies')) {
        initDb();
    }

    ensureChoreTemplateSchema($db);
}

function resetSchema(): void
{
    $db = getDb();
    $db->exec('SET FOREIGN_KEY_CHECKS=0');
    $tables = $db->query('SHOW TABLES')->fetchAll(PDO::FETCH_COLUMN);
    foreach ($tables as $table) {
        $db->exec('DROP TABLE IF EXISTS `' . $table . '`');
    }
    $db->exec('SET FOREIGN_KEY_CHECKS=1');
    initDb();
}

function runMigration(?array $types = null): void
{
    if ($types === null) {
        $types = ['stores', 'user_store_roles', 'staff', 'csv'];
    }

    $db = getDb();
    ensureBaseSchema($db);
    $db = getDb();
    if ((int) $db->query('SELECT COUNT(*) FROM companies')->fetchColumn() === 0) {
        $db->exec("INSERT INTO companies (name) VALUES ('Main Company')");
    }
    $companyId = (int) $db->query('SELECT id FROM companies LIMIT 1')->fetchColumn();
    $db->prepare('UPDATE stores SET company_id = ? WHERE company_id IS NULL')->execute([$companyId]);
    $db->prepare('UPDATE users SET company_id = ? WHERE company_id IS NULL')->execute([$companyId]);

    if (in_array('stores', $types, true) && file_exists(__DIR__ . '/../stores.json')) {
        $stores = json_decode(file_get_contents(__DIR__ . '/../stores.json'), true);
        if (is_array($stores)) {
            foreach ($stores as $store) {
                saveStore($store);
            }
        }
    }

    if ((int) $db->query('SELECT COUNT(*) FROM stores')->fetchColumn() === 0) {
        saveStore(['name' => 'Main Store']);
    }

    if (in_array('user_store_roles', $types, true) && file_exists(__DIR__ . '/../user_store_roles.json')) {
        $roles = json_decode(file_get_contents(__DIR__ . '/../user_store_roles.json'), true);
        if (is_array($roles)) {
            foreach ($roles as $role) {
                assign_user_store_role(
                    $role['userId'] ?? $role['user_id'] ?? 0,
                    $role['storeId'] ?? $role['store_id'] ?? 0,
                    $role['role'] ?? ''
                );
            }
        }
    }


    // schedule and chores data are now stored directly in the database

    if (in_array('csv', $types, true) && file_exists(__DIR__ . '/../data.csv')) {
        $fh = fopen(__DIR__ . '/../data.csv', 'r');
        if ($fh) {
            $db->beginTransaction();
            $storeId = (int) $db->query('SELECT id FROM stores ORDER BY id LIMIT 1')->fetchColumn();
            $insertStaff = $db->prepare('INSERT IGNORE INTO staff (name, store_id) VALUES (?, ?)');
            $findStaff = $db->prepare('SELECT id FROM staff WHERE name = ?');
            $insertShift = $db->prepare(
                'INSERT INTO shifts (staff_id, date, shift_hours, pos, break1, lunch, break2, tasks, store_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
            );
            while (($row = fgetcsv($fh, 0, ',', '"', '\\')) !== false) {
                $name = trim($row[0] ?? '');
                if ($name === '') {
                    continue;
                }
                $insertStaff->execute([$name, $storeId]);
                $findStaff->execute([$name]);
                $staffId = (int) $findStaff->fetchColumn();
                $insertShift->execute([
                    $staffId,
                    '1970-01-01',
                    $row[2] ?? '',
                    $row[1] ?? '',
                    $row[3] ?? '',
                    $row[4] ?? '',
                    $row[5] ?? '',
                    $row[6] ?? '',
                    $storeId,
                ]);
            }
            fclose($fh);
            $db->commit();
        }
    }

    // Ensure a default break template exists for each company
    migrateTemplates();
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    $args = $argv;
    array_shift($args);
    runMigration($args ?: null);
    echo "Migration complete\n";
}
