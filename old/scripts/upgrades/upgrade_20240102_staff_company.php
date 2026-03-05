<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20240102StaffCompany
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        $db      = getDb();

        if (!UpgradeSchemaHelper::tableExists($db, 'staff')) {
            self::log($logger, 'Staff table not found; skipping staff company migration.');

            return;
        }

        self::log($logger, 'Updating staff table for company scoping.');

        self::ensureStoreIdNullable($db, $logger);
        self::ensureCompanyColumn($db, $logger);
        self::backfillCompanyIds($db, $logger);
        self::finaliseCompanyColumn($db, $logger);
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

    private static function ensureStoreIdNullable(PDO $db, callable $logger): void
    {
        $definition = UpgradeSchemaHelper::getColumnDefinition($db, 'staff', 'store_id');
        if ($definition !== null && strtoupper((string) ($definition['IS_NULLABLE'] ?? '')) !== 'YES') {
            self::log($logger, 'Allowing NULL store assignments for staff.');
            $db->exec('ALTER TABLE `staff` MODIFY `store_id` INT UNSIGNED NULL');
        }
    }

    private static function ensureCompanyColumn(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::columnExists($db, 'staff', 'company_id')) {
            self::log($logger, 'Adding staff.company_id column.');
            $db->exec('ALTER TABLE `staff` ADD COLUMN `company_id` INT UNSIGNED NULL AFTER `store_id`');
        }

        if (!UpgradeSchemaHelper::indexExists($db, 'staff', 'idx_staff_company')) {
            self::log($logger, 'Adding idx_staff_company index.');
            $db->exec('ALTER TABLE `staff` ADD INDEX `idx_staff_company` (`company_id`)');
        }

        if (!UpgradeSchemaHelper::indexExists($db, 'staff', 'idx_staff_store')) {
            self::log($logger, 'Adding idx_staff_store index.');
            $db->exec('ALTER TABLE `staff` ADD INDEX `idx_staff_store` (`store_id`)');
        }

        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'staff', 'fk_staff_company')) {
            self::log($logger, 'Adding fk_staff_company foreign key.');
            $db->exec(
                'ALTER TABLE `staff`'
                . ' ADD CONSTRAINT `fk_staff_company`'
                . ' FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)' . ' ON UPDATE CASCADE ON DELETE RESTRICT'
            );
        }

        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'staff', 'fk_staff_store')) {
            if (UpgradeSchemaHelper::tableExists($db, 'stores')) {
                self::log($logger, 'Adding fk_staff_store foreign key.');
                $db->exec(
                    'ALTER TABLE `staff`'
                    . ' ADD CONSTRAINT `fk_staff_store`'
                    . ' FOREIGN KEY (`store_id`) REFERENCES `stores`(`id`)' . ' ON UPDATE CASCADE ON DELETE SET NULL'
                );
            }
        }
    }

    private static function backfillCompanyIds(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::columnExists($db, 'staff', 'company_id')) {
            return;
        }

        $defaultCompanyId = $db->query('SELECT id FROM `companies` ORDER BY id LIMIT 1')->fetchColumn();
        $defaultCompanyId = $defaultCompanyId === false ? null : (int) $defaultCompanyId;

        if (UpgradeSchemaHelper::tableExists($db, 'stores') && UpgradeSchemaHelper::columnExists($db, 'stores', 'company_id')) {
            self::log($logger, 'Deriving staff company assignments from stores.');
            $db->exec(
                'UPDATE `staff` s JOIN `stores` st ON s.store_id = st.id'
                . ' SET s.company_id = st.company_id'
                . ' WHERE s.store_id IS NOT NULL AND (s.company_id IS NULL OR s.company_id = 0)'
            );
        }

        if ($defaultCompanyId !== null) {
            self::log($logger, 'Assigning default company to unscoped staff members.');
            $stmt = $db->prepare('UPDATE `staff` SET `company_id` = ? WHERE `company_id` IS NULL OR `company_id` = 0');
            $stmt->execute([$defaultCompanyId]);
        }
    }

    private static function finaliseCompanyColumn(PDO $db, callable $logger): void
    {
        $definition = UpgradeSchemaHelper::getColumnDefinition($db, 'staff', 'company_id');
        if ($definition !== null && strtoupper((string) ($definition['IS_NULLABLE'] ?? '')) === 'YES') {
            self::log($logger, 'Enforcing NOT NULL on staff.company_id.');
            $db->exec('ALTER TABLE `staff` MODIFY `company_id` INT UNSIGNED NOT NULL');
        }
    }
}
