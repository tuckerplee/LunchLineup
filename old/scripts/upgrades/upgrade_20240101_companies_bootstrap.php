<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20240101CompaniesBootstrap
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        $db      = getDb();

        self::log($logger, 'Ensuring companies schema is up to date.');

        self::ensureCompaniesTable($db, $logger);
        self::ensureStoresHaveCompanies($db, $logger);
        self::ensureUsersHaveCompanies($db, $logger);
        self::assignCompanyAdmins($db, $logger);
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

    private static function ensureCompaniesTable(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::tableExists($db, 'companies')) {
            self::log($logger, 'Creating companies table.');
            $db->exec(
                'CREATE TABLE `companies` ('
                . ' `id` INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,'
                . ' `name` VARCHAR(255) NOT NULL,'
                . ' `created_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP,'
                . ' `updated_at` TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP'
                . ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
            );
        }

        $count = (int) $db->query('SELECT COUNT(*) FROM `companies`')->fetchColumn();
        if ($count === 0) {
            self::log($logger, 'Seeding default company record.');
            $stmt = $db->prepare('INSERT INTO `companies` (name) VALUES (?)');
            $stmt->execute(['Main Company']);
        }
    }

    private static function ensureStoresHaveCompanies(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::tableExists($db, 'stores')) {
            self::log($logger, 'Stores table not found; skipping store company updates.');

            return;
        }

        if (!UpgradeSchemaHelper::columnExists($db, 'stores', 'company_id')) {
            self::log($logger, 'Adding stores.company_id column.');
            $db->exec('ALTER TABLE `stores` ADD COLUMN `company_id` INT UNSIGNED NULL AFTER `id`');
        }

        if (!UpgradeSchemaHelper::indexExists($db, 'stores', 'idx_store_company')) {
            self::log($logger, 'Adding idx_store_company index.');
            $db->exec('ALTER TABLE `stores` ADD INDEX `idx_store_company` (`company_id`)');
        }

        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'stores', 'fk_stores_company')) {
            self::log($logger, 'Adding fk_stores_company foreign key.');
            $db->exec(
                'ALTER TABLE `stores`'
                . ' ADD CONSTRAINT `fk_stores_company`'
                . ' FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)' . ' ON UPDATE CASCADE ON DELETE RESTRICT'
            );
        }

        $defaultCompanyId = self::defaultCompanyId($db);
        if ($defaultCompanyId === null) {
            return;
        }

        self::log($logger, 'Backfilling stores without a company.');
        $stmt = $db->prepare('UPDATE `stores` SET `company_id` = ? WHERE `company_id` IS NULL OR `company_id` = 0');
        $stmt->execute([$defaultCompanyId]);

        $definition = UpgradeSchemaHelper::getColumnDefinition($db, 'stores', 'company_id');
        if ($definition !== null && strtoupper((string) ($definition['IS_NULLABLE'] ?? '')) === 'YES') {
            self::log($logger, 'Enforcing NOT NULL on stores.company_id.');
            $db->exec('ALTER TABLE `stores` MODIFY `company_id` INT UNSIGNED NOT NULL');
        }
    }

    private static function ensureUsersHaveCompanies(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::tableExists($db, 'users')) {
            self::log($logger, 'Users table not found; skipping user company updates.');

            return;
        }

        if (!UpgradeSchemaHelper::columnExists($db, 'users', 'company_id')) {
            self::log($logger, 'Adding users.company_id column.');
            $db->exec('ALTER TABLE `users` ADD COLUMN `company_id` INT UNSIGNED NULL AFTER `id`');
        }

        if (!UpgradeSchemaHelper::indexExists($db, 'users', 'idx_users_company')) {
            self::log($logger, 'Adding idx_users_company index.');
            $db->exec('ALTER TABLE `users` ADD INDEX `idx_users_company` (`company_id`)');
        }

        if (!UpgradeSchemaHelper::foreignKeyExists($db, 'users', 'fk_users_company')) {
            self::log($logger, 'Adding fk_users_company foreign key.');
            $db->exec(
                'ALTER TABLE `users`'
                . ' ADD CONSTRAINT `fk_users_company`'
                . ' FOREIGN KEY (`company_id`) REFERENCES `companies`(`id`)' . ' ON UPDATE CASCADE ON DELETE RESTRICT'
            );
        }

        $defaultCompanyId = self::defaultCompanyId($db);
        if ($defaultCompanyId === null) {
            return;
        }

        self::log($logger, 'Backfilling users without a company.');
        $stmt = $db->prepare('UPDATE `users` SET `company_id` = ? WHERE `company_id` IS NULL OR `company_id` = 0');
        $stmt->execute([$defaultCompanyId]);

        $definition = UpgradeSchemaHelper::getColumnDefinition($db, 'users', 'company_id');
        if ($definition !== null && strtoupper((string) ($definition['IS_NULLABLE'] ?? '')) === 'YES') {
            self::log($logger, 'Enforcing NOT NULL on users.company_id.');
            $db->exec('ALTER TABLE `users` MODIFY `company_id` INT UNSIGNED NOT NULL');
        }
    }

    private static function assignCompanyAdmins(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::tableExists($db, 'user_company_roles')) {
            self::log($logger, 'user_company_roles table not found; skipping admin role sync.');

            return;
        }

        $defaultCompanyId = self::defaultCompanyId($db);
        if ($defaultCompanyId === null) {
            return;
        }

        $superAdmins = $db->query(
            "SELECT DISTINCT user_id FROM `user_company_roles` WHERE role = 'super_admin'"
        )->fetchAll(PDO::FETCH_COLUMN);

        if ($superAdmins === []) {
            return;
        }

        $insert = $db->prepare(
            'INSERT IGNORE INTO `user_company_roles` (user_id, company_id, role) VALUES (?, ?, ?)'
        );

        foreach ($superAdmins as $userId) {
            $insert->execute([(int) $userId, $defaultCompanyId, 'company_admin']);
        }

        self::log($logger, 'Ensured super admins are company admins for the default company.');
    }

    private static function defaultCompanyId(PDO $db): ?int
    {
        $id = $db->query('SELECT id FROM `companies` ORDER BY id LIMIT 1')->fetchColumn();

        return $id === false ? null : (int) $id;
    }
}
