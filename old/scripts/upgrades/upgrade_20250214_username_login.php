<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20250214UsernameLogin
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        self::log($logger, 'Starting username login upgrade.');

        $db = getDb();

        self::renameUserLoginColumns($db, $logger);
        self::renameUserHashColumns($db, $logger);
        self::renameHashIndex($db, $logger);
        self::renameUserUniqueIndex($db, $logger);
        self::renameMailQueueLoginColumn($db, $logger);
        self::ensureSuperAdminUsernames($db, $logger);

        self::log($logger, 'Username login upgrade complete.');
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

    private static function renameUserLoginColumns(PDO $db, callable $logger): void
    {
        $hasUsername = UpgradeSchemaHelper::columnExists($db, 'users', 'username');
        if ($hasUsername) {
            self::log($logger, 'users.username column already present.');
            return;
        }

        if (!UpgradeSchemaHelper::columnExists($db, 'users', 'email')) {
            self::log($logger, 'users.email column not found; skipping rename.');
            return;
        }

        self::log($logger, 'Renaming users.email to users.username.');
        $db->exec('ALTER TABLE `users` CHANGE COLUMN `email` `username` VARCHAR(512) NOT NULL UNIQUE');
    }

    private static function renameUserHashColumns(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::columnExists($db, 'users', 'usernameHash')
            && UpgradeSchemaHelper::columnExists($db, 'users', 'emailHash')
        ) {
            self::log($logger, 'Renaming users.emailHash to users.usernameHash.');
            $db->exec('ALTER TABLE `users` CHANGE COLUMN `emailHash` `usernameHash` CHAR(64) NOT NULL');
        } else {
            self::log($logger, 'users.usernameHash column already present or source column missing.');
        }

        if (!UpgradeSchemaHelper::columnExists($db, 'users', 'username_hash')
            && UpgradeSchemaHelper::columnExists($db, 'users', 'email_hash')
        ) {
            self::log($logger, 'Renaming users.email_hash to users.username_hash.');
            $db->exec('ALTER TABLE `users` CHANGE COLUMN `email_hash` `username_hash` CHAR(64) NOT NULL');
        } elseif (UpgradeSchemaHelper::columnExists($db, 'users', 'username_hash')) {
            self::log($logger, 'users.username_hash column already present.');
        }
    }

    private static function renameHashIndex(PDO $db, callable $logger): void
    {
        if (UpgradeSchemaHelper::indexExists($db, 'users', 'idx_users_email_hash')) {
            self::log($logger, 'Renaming idx_users_email_hash index to idx_users_username_hash.');
            $db->exec('ALTER TABLE `users` RENAME INDEX `idx_users_email_hash` TO `idx_users_username_hash`');
            return;
        }

        if (!UpgradeSchemaHelper::indexExists($db, 'users', 'idx_users_username_hash')
            && UpgradeSchemaHelper::columnExists($db, 'users', 'usernameHash')
        ) {
            self::log($logger, 'Adding idx_users_username_hash unique index.');
            $db->exec('ALTER TABLE `users` ADD UNIQUE INDEX `idx_users_username_hash` (`usernameHash`)');
        }
    }

    private static function renameUserUniqueIndex(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::indexExists($db, 'users', 'email')) {
            self::log($logger, 'users email unique index not found; nothing to rename.');
            return;
        }

        if (UpgradeSchemaHelper::indexExists($db, 'users', 'username')) {
            self::log($logger, 'users.username unique index already exists; dropping legacy email index.');
            $db->exec('ALTER TABLE `users` DROP INDEX `email`');
            return;
        }

        self::log($logger, 'Renaming users unique email index to username.');
        $db->exec('ALTER TABLE `users` RENAME INDEX `email` TO `username`');
    }

    private static function renameMailQueueLoginColumn(PDO $db, callable $logger): void
    {
        $hasUsername = UpgradeSchemaHelper::columnExists($db, 'mail_queue', 'username');
        if ($hasUsername) {
            self::log($logger, 'mail_queue.username column already present.');
            return;
        }

        if (!UpgradeSchemaHelper::columnExists($db, 'mail_queue', 'email')) {
            self::log($logger, 'mail_queue.email column not found; skipping rename.');
            return;
        }

        self::log($logger, 'Renaming mail_queue.email to mail_queue.username.');
        $db->exec('ALTER TABLE `mail_queue` CHANGE COLUMN `email` `username` VARCHAR(255) NOT NULL');
    }

    private static function ensureSuperAdminUsernames(PDO $db, callable $logger): void
    {
        $usernameColumn = getUserUsernameColumn();
        $hashColumns    = getUserUsernameHashColumns();

        $stmt = $db->prepare(
            'SELECT DISTINCT u.id, u.' . $usernameColumn . ' AS username_value '
            . 'FROM users u '
            . "INNER JOIN user_company_roles ucr ON ucr.user_id = u.id AND ucr.role = 'super_admin' "
            . 'ORDER BY u.id'
        );
        $stmt->execute();
        $rows = $stmt->fetchAll(PDO::FETCH_ASSOC);
        if ($rows === []) {
            self::log($logger, 'No super admin accounts detected for username migration.');
            return;
        }

        $updated = 0;
        foreach ($rows as $row) {
            $userId          = (int) $row['id'];
            $decrypted       = isset($row['username_value'])
                ? trim(decryptField((string) $row['username_value']))
                : '';
            if (!self::requiresUsernameMigration($decrypted)) {
                self::log($logger, 'Super admin #' . $userId . ' already has a username configured.');
                continue;
            }
            $username = self::promptForUsername($userId, $decrypted, $db, $hashColumns);
            self::updateUsernameColumns($db, $userId, $usernameColumn, $hashColumns, $username);
            $updated++;
            self::log($logger, 'Updated super admin #' . $userId . ' username.');
        }

        if ($updated === 0) {
            self::log($logger, 'All super admin usernames already configured; no changes applied.');
        }
    }

    private static function requiresUsernameMigration(string $username): bool
    {
        if ($username === '') {
            return true;
        }

        return strpos($username, '@') !== false;
    }

    /**
     * @param array<int,string> $hashColumns
     */
    private static function promptForUsername(int $userId, string $current, PDO $db, array $hashColumns): string
    {
        $suggestion = self::suggestUsername($current, $userId);
        while (true) {
            $prompt = 'Enter a username for super admin #' . $userId;
            if ($current !== '') {
                $prompt .= ' (current value: ' . $current . ')';
            }
            if ($suggestion !== '') {
                $prompt .= ' [' . $suggestion . ']';
            }
            $prompt .= ': ';
            $input = self::readInput($prompt);
            if ($input === '' && $suggestion !== '') {
                $input = $suggestion;
            }
            $input = trim($input);
            $validationError = self::validateUsername($input);
            if ($validationError !== null) {
                self::outputLine($validationError);
                continue;
            }

            if (self::usernameExists($db, $hashColumns, $input, $userId)) {
                self::outputLine('Username already in use. Please choose another.');
                continue;
            }

            return $input;
        }
    }

    private static function readInput(string $prompt): string
    {
        if (function_exists('readline')) {
            $line = readline($prompt);
            if ($line !== false) {
                return trim($line);
            }
        }

        self::outputRaw($prompt);
        $line = fgets(STDIN);
        if ($line === false) {
            throw new RuntimeException('Unable to read input from STDIN. Re-run the upgrade in an interactive shell.');
        }

        return trim($line);
    }

    private static function outputLine(string $message): void
    {
        self::outputRaw($message . PHP_EOL);
    }

    private static function outputRaw(string $message): void
    {
        fwrite(STDOUT, $message);
    }

    private static function suggestUsername(string $current, int $userId): string
    {
        $candidate = $current;
        if (strpos($current, '@') !== false) {
            $local = substr($current, 0, (int) strpos($current, '@'));
            $candidate = $local !== '' ? $local : 'superadmin' . $userId;
        }
        $candidate = strtolower(preg_replace('/[^a-z0-9._-]/i', '_', $candidate));
        $candidate = trim($candidate, '._-');
        if ($candidate === '' || strlen($candidate) < 3) {
            $candidate = 'superadmin' . $userId;
        }
        if (strlen($candidate) > 64) {
            $candidate = substr($candidate, 0, 64);
        }

        return $candidate;
    }

    private static function validateUsername(string $username): ?string
    {
        if ($username === '') {
            return 'Username cannot be empty.';
        }
        $length = strlen($username);
        if ($length < 3 || $length > 64) {
            return 'Username must be between 3 and 64 characters.';
        }
        if (!preg_match('/^[A-Za-z0-9._-]+$/', $username)) {
            return 'Username may only contain letters, numbers, dots, underscores, or hyphens.';
        }

        return null;
    }

    /**
     * @param array<int,string> $hashColumns
     */
    private static function usernameExists(PDO $db, array $hashColumns, string $username, int $excludeUserId): bool
    {
        if ($hashColumns === []) {
            return false;
        }
        $hash       = usernameHash($username);
        $conditions = [];
        $params     = [];
        foreach ($hashColumns as $column) {
            $conditions[] = $column . ' = ?';
            $params[]     = $hash;
        }
        $sql      = 'SELECT id FROM users WHERE (' . implode(' OR ', $conditions) . ') AND id <> ? LIMIT 1';
        $params[] = $excludeUserId;
        $stmt     = $db->prepare($sql);
        $stmt->execute($params);

        return $stmt->fetchColumn() !== false;
    }

    /**
     * @param array<int,string> $hashColumns
     */
    private static function updateUsernameColumns(
        PDO $db,
        int $userId,
        string $usernameColumn,
        array $hashColumns,
        string $username
    ): void {
        $fields = [$usernameColumn . ' = ?'];
        $params = [encryptField($username)];
        $hash   = usernameHash($username);
        foreach ($hashColumns as $column) {
            $fields[] = $column . ' = ?';
            $params[] = $hash;
        }
        $fields[] = 'updated_at = CURRENT_TIMESTAMP';
        $params[] = $userId;
        $sql      = 'UPDATE users SET ' . implode(', ', $fields) . ' WHERE id = ?';
        $stmt     = $db->prepare($sql);
        $stmt->execute($params);
    }
}
