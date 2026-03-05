<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';
require_once __DIR__ . '/../../src/data/staff.php';

final class Upgrade20240106StaffAdminFlag
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        $db      = getDb();

        if (!UpgradeSchemaHelper::tableExists($db, 'staff')) {
            self::log($logger, 'Staff table not found; skipping admin flag sync.');

            return;
        }

        self::ensureAdminColumn($db, $logger);
        self::synchronizeFlags($db, $logger);
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

    private static function ensureAdminColumn(PDO $db, callable $logger): void
    {
        $column = staff_admin_column();
        if ($column !== '') {
            return;
        }

        self::log($logger, 'Adding staff.is_admin column.');
        $db->exec('ALTER TABLE `staff` ADD COLUMN `is_admin` TINYINT(1) NOT NULL DEFAULT 0 AFTER `tasks`');
    }

    private static function synchronizeFlags(PDO $db, callable $logger): void
    {
        $adminColumn = staff_admin_column();
        if ($adminColumn === '') {
            self::log($logger, 'No admin flag column detected; skipping sync.');

            return;
        }

        if (!UpgradeSchemaHelper::tableExists($db, 'user_company_roles')) {
            self::log($logger, 'user_company_roles table not found; skipping admin role sync.');

            return;
        }

        $companyScoped = UpgradeSchemaHelper::columnExists($db, 'staff', 'company_id');

        $sql = 'UPDATE `staff` s LEFT JOIN `user_company_roles` ucr ON s.id = ucr.user_id';
        if ($companyScoped && UpgradeSchemaHelper::columnExists($db, 'user_company_roles', 'company_id')) {
            $sql .= ' AND s.company_id = ucr.company_id';
        }
        $sql .= " AND ucr.role IN ('company_admin','super_admin')";
        $sql .= ' SET s.`' . $adminColumn . '` = IF(ucr.user_id IS NULL, 0, 1)';

        self::log($logger, 'Aligning staff admin flags with company roles.');
        $db->exec($sql);
    }
}
