<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/crypto.php';

final class EmailHashUpgrade
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        self::log($logger, 'Starting email hash upgrade.');

        try {
            get_app_key();
        } catch (RuntimeException $exception) {
            throw new RuntimeException(
                'APP_KEY must be configured before running the email hash upgrade: ' . $exception->getMessage(),
                0,
                $exception
            );
        }

        $db = getDb();
        self::ensureEncryptedFieldCapacity($db, $logger);
        self::ensureEmailHashColumn($db, $logger);
        self::backfillEmailHashes($db, $logger);
        self::finaliseEmailHashColumn($db, $logger);
        self::log($logger, 'Email hash upgrade complete.');
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

    private static function ensureEncryptedFieldCapacity(PDO $db, callable $logger): void
    {
        $userEmail = self::getColumnDefinition($db, 'users', 'email');
        if ($userEmail === null) {
            throw new RuntimeException('users table not found; run migrations before upgrading.');
        }
        $userLength = isset($userEmail['CHARACTER_MAXIMUM_LENGTH'])
            ? (int) $userEmail['CHARACTER_MAXIMUM_LENGTH']
            : 0;
        if ($userLength > 0 && $userLength < 512) {
            self::log($logger, 'Expanding users.email column to 512 characters for encrypted values.');
            $db->exec('ALTER TABLE `users` MODIFY `email` VARCHAR(512) NOT NULL');
        }

        $staffName = self::getColumnDefinition($db, 'staff', 'name');
        if ($staffName !== null) {
            $staffLength = isset($staffName['CHARACTER_MAXIMUM_LENGTH'])
                ? (int) $staffName['CHARACTER_MAXIMUM_LENGTH']
                : 0;
            if ($staffLength > 0 && $staffLength < 512) {
                self::log($logger, 'Expanding staff.name column to 512 characters for encrypted values.');
                $db->exec('ALTER TABLE `staff` MODIFY `name` VARCHAR(512) NOT NULL');
            }
        }
    }

    private static function ensureEmailHashColumn(PDO $db, callable $logger): void
    {
        $column = self::getColumnDefinition($db, 'users', 'emailHash');
        if ($column === null) {
            self::log($logger, 'Adding nullable users.emailHash column.');
            $db->exec('ALTER TABLE `users` ADD COLUMN `emailHash` CHAR(64) NULL');

            return;
        }

        $type = strtolower((string) ($column['COLUMN_TYPE'] ?? ''));
        if ($type !== 'char(64)') {
            $nullability = strtoupper((string) ($column['IS_NULLABLE'] ?? 'NO')) === 'YES' ? 'NULL' : 'NOT NULL';
            self::log($logger, 'Normalising users.emailHash column definition to CHAR(64).');
            $db->exec("ALTER TABLE `users` MODIFY `emailHash` CHAR(64) {$nullability}");
        } else {
            self::log($logger, 'users.emailHash column already present.');
        }
    }

    private static function backfillEmailHashes(PDO $db, callable $logger): void
    {
        self::log($logger, 'Backfilling users.emailHash values from encrypted emails.');
        $select = $db->query('SELECT id, email, emailHash FROM `users`');
        $select->setFetchMode(PDO::FETCH_ASSOC);
        $update = $db->prepare('UPDATE `users` SET `emailHash` = ? WHERE `id` = ?');

        $processed = 0;
        $updated   = 0;
        while ($row = $select->fetch()) {
            $processed++;
            $emailValue = $row['email'] ?? null;
            if ($emailValue === null) {
                throw new RuntimeException('Encountered NULL users.email value for user ID ' . $row['id']);
            }

            try {
                $plaintext = decryptField((string) $emailValue);
            } catch (Throwable $exception) {
                throw new RuntimeException(
                    'Failed to decrypt email for user ID ' . $row['id'] . ': ' . $exception->getMessage(),
                    0,
                    $exception
                );
            }

            $hash = emailHash($plaintext);
            $currentHash = $row['emailHash'] ?? null;
            if (!is_string($currentHash) || $currentHash !== $hash) {
                $update->execute([$hash, (int) $row['id']]);
                $updated++;
            }
        }

        self::log($logger, "Processed {$processed} users; updated {$updated} email hash values.");
    }

    private static function finaliseEmailHashColumn(PDO $db, callable $logger): void
    {
        $missing = self::countMissingHashes($db);
        if ($missing > 0) {
            throw new RuntimeException('users.emailHash still has ' . $missing . ' NULL values after backfill.');
        }

        $column = self::getColumnDefinition($db, 'users', 'emailHash');
        if ($column === null) {
            throw new RuntimeException('users.emailHash column missing after backfill.');
        }

        if (strtoupper((string) ($column['IS_NULLABLE'] ?? 'NO')) === 'YES') {
            self::log($logger, 'Marking users.emailHash column as NOT NULL.');
            $db->exec('ALTER TABLE `users` MODIFY `emailHash` CHAR(64) NOT NULL');
        }

        if (!self::hasUniqueIndex($db, 'users', 'emailHash')) {
            self::log($logger, 'Adding unique index on users.emailHash.');
            $db->exec('ALTER TABLE `users` ADD UNIQUE INDEX `idx_users_email_hash` (`emailHash`)');
        } else {
            self::log($logger, 'Unique index on users.emailHash already exists.');
        }
    }

    private static function getColumnDefinition(PDO $db, string $table, string $column): ?array
    {
        $config = getConfig();
        $stmt = $db->prepare(
            'SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, CHARACTER_MAXIMUM_LENGTH '
            . 'FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?'
        );
        $stmt->execute([$config['dbname'], $table, $column]);
        $result = $stmt->fetch(PDO::FETCH_ASSOC);

        return $result === false ? null : $result;
    }

    private static function hasUniqueIndex(PDO $db, string $table, string $column): bool
    {
        $config = getConfig();
        $stmt = $db->prepare(
            'SELECT 1 FROM INFORMATION_SCHEMA.STATISTICS '
            . 'WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ? AND NON_UNIQUE = 0 LIMIT 1'
        );
        $stmt->execute([$config['dbname'], $table, $column]);

        return $stmt->fetchColumn() !== false;
    }

    private static function countMissingHashes(PDO $db): int
    {
        $stmt = $db->query("SELECT COUNT(*) FROM `users` WHERE `emailHash` IS NULL OR `emailHash` = ''");

        return (int) $stmt->fetchColumn();
    }
}
