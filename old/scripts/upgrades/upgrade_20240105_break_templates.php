<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20240105BreakTemplates
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        $db      = getDb();

        self::ensureBreakTemplatesTable($db, $logger);
        self::seedCompanyTemplates($db, $logger);
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

    private static function ensureBreakTemplatesTable(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::tableExists($db, 'break_templates')) {
            self::log($logger, 'Creating break_templates table.');
            $db->exec(
                'CREATE TABLE `break_templates` ('
                . ' `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,'
                . ' `company_id` INT UNSIGNED DEFAULT NULL,'
                . ' `name` VARCHAR(255) NOT NULL,'
                . ' `break1_offset` TINYINT UNSIGNED NOT NULL,'
                . ' `break1_duration` TINYINT UNSIGNED NOT NULL,'
                . ' `lunch_offset` TINYINT UNSIGNED NOT NULL,'
                . ' `lunch_duration` TINYINT UNSIGNED NOT NULL,'
                . ' `break2_offset` TINYINT UNSIGNED NOT NULL,'
                . ' `break2_duration` TINYINT UNSIGNED NOT NULL,'
                . ' UNIQUE KEY `uniq_break_templates_company_name` (`company_id`, `name`),'
                . ' INDEX `idx_break_templates_company` (`company_id`),'
                . ' CONSTRAINT `fk_break_templates_company`'
                . ' FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)' . ' ON UPDATE CASCADE ON DELETE CASCADE'
                . ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        }
    }

    private static function seedCompanyTemplates(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::tableExists($db, 'break_templates')) {
            return;
        }

        $default = $db->query(
            'SELECT break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration'
            . ' FROM `break_templates` WHERE `company_id` IS NULL LIMIT 1'
        )->fetch(PDO::FETCH_ASSOC);

        if ($default === false) {
            $default = [
                'break1_offset' => 2,
                'break1_duration' => 10,
                'lunch_offset' => 4,
                'lunch_duration' => 60,
                'break2_offset' => 2,
                'break2_duration' => 10,
            ];
            self::log($logger, 'Seeding global default break template.');
            $stmt = $db->prepare(
                'INSERT INTO `break_templates` (company_id, name, break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration)'
                . ' VALUES (NULL, "Default", ?, ?, ?, ?, ?, ?)'
            );
            $stmt->execute([
                $default['break1_offset'],
                $default['break1_duration'],
                $default['lunch_offset'],
                $default['lunch_duration'],
                $default['break2_offset'],
                $default['break2_duration'],
            ]);
        }

        if (!UpgradeSchemaHelper::tableExists($db, 'companies')) {
            return;
        }

        $companies = $db->query('SELECT id FROM `companies`')->fetchAll(PDO::FETCH_COLUMN);
        if ($companies === false || $companies === []) {
            return;
        }

        $insert = $db->prepare(
            'INSERT IGNORE INTO `break_templates` (company_id, name, break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration)'
            . ' VALUES (?, "Default", ?, ?, ?, ?, ?, ?)'
        );

        foreach ($companies as $companyId) {
            $insert->execute([
                (int) $companyId,
                $default['break1_offset'],
                $default['break1_duration'],
                $default['lunch_offset'],
                $default['lunch_duration'],
                $default['break2_offset'],
                $default['break2_duration'],
            ]);
        }

        self::log($logger, 'Ensured default break templates exist for ' . count($companies) . ' companies.');
    }
}
