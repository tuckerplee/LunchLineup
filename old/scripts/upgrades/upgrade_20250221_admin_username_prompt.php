<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20250221AdminUsernamePrompt
{
    /**
     * @var array<int,string>
     */
    private static array $providedUsernames = [];

    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        self::log($logger, 'Starting account username prompt.');

        $db             = getDb();
        $usernameColumn = getUserUsernameColumn();
        $hashColumns    = getUserUsernameHashColumns();

        $accounts = self::fetchLoginUsers($db, $usernameColumn);
        if ($accounts === []) {
            self::log($logger, 'No user accounts detected for username migration.');
            return;
        }

        $updated = 0;
        foreach ($accounts as $row) {
            $userId    = (int) $row['id'];
            $raw       = (string) ($row['username_value'] ?? '');
            $decrypted = trim(decryptField($raw));
            if (!self::requiresUsernameMigration($decrypted)) {
                self::log($logger, 'User account #' . $userId . ' already has a username configured.');
                continue;
            }

            $username = self::getProvidedUsername($userId);
            if ($username !== null) {
                $validationError = self::validateUsername($username);
                if ($validationError !== null) {
                    throw new RuntimeException(
                        'Invalid username provided for user account #' . $userId . ': ' . $validationError
                    );
                }
                if (self::usernameExists($db, $hashColumns, $username, $userId)) {
                    throw new RuntimeException(
                        'Username "' . $username . '" is already in use. Choose another username for user account #'
                        . $userId . '.'
                    );
                }
            } elseif (self::hasInteractiveInput()) {
                $username = self::promptForUsername($userId, $decrypted, $row['roles'], $db, $hashColumns);
            } else {
                throw new RuntimeException(
                    'Username required for user account #' . $userId
                    . '. Provide usernames via the upgrade portal and rerun the upgrade.'
                );
            }

            self::updateUsernameColumns($db, $userId, $usernameColumn, $hashColumns, $username);
            $updated++;
            self::log($logger, 'Updated user account #' . $userId . ' username.');
        }

        if ($updated === 0) {
            self::log($logger, 'All user accounts already have usernames; no changes applied.');
        } else {
            self::log($logger, 'Account username prompt complete. Updated ' . $updated . ' account(s).');
        }
    }

    public static function setProvidedUsernames(array $usernames): void
    {
        self::$providedUsernames = [];
        foreach ($usernames as $userId => $username) {
            $id   = (int) $userId;
            $trim = trim((string) $username);
            if ($id > 0 && $trim !== '') {
                self::$providedUsernames[$id] = $trim;
            }
        }
    }

    public static function pendingAdminAccounts(): array
    {
        $db             = getDb();
        $usernameColumn = getUserUsernameColumn();
        $rows           = self::fetchLoginUsers($db, $usernameColumn);
        $pending        = [];
        foreach ($rows as $row) {
            $userId    = (int) $row['id'];
            $raw       = (string) ($row['username_value'] ?? '');
            $decrypted = trim(decryptField($raw));
            if (!self::requiresUsernameMigration($decrypted)) {
                continue;
            }
            $pending[] = [
                'id'         => $userId,
                'current'    => $decrypted,
                'roles'      => $row['roles'] !== null ? explode(',', (string) $row['roles']) : [],
                'suggestion' => self::suggestUsername($decrypted, $userId),
            ];
        }

        return $pending;
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

    private static function fetchLoginUsers(PDO $db, string $usernameColumn): array
    {
        $roleSources = [];
        if (UpgradeSchemaHelper::tableExists($db, 'user_company_roles')) {
            $roleSources[] = 'SELECT user_id, role FROM user_company_roles';
        }
        if (UpgradeSchemaHelper::tableExists($db, 'user_store_roles')) {
            $roleSources[] = 'SELECT user_id, role FROM user_store_roles';
        }

        $roleField = 'NULL AS roles';
        $roleJoin  = '';
        $groupBy   = '';
        if ($roleSources !== []) {
            $roleJoin  = ' LEFT JOIN (' . implode(' UNION ALL ', $roleSources) . ') roles ON roles.user_id = u.id';
            $roleField = 'GROUP_CONCAT(DISTINCT roles.role ORDER BY roles.role SEPARATOR \',\') AS roles';
            $groupBy   = ' GROUP BY u.id, u.' . $usernameColumn;
        }

        $sql = 'SELECT u.id, u.' . $usernameColumn . ' AS username_value, '
            . $roleField
            . ' FROM users u'
            . $roleJoin
            . $groupBy
            . ' ORDER BY u.id';

        $stmt = $db->prepare($sql);
        $stmt->execute();

        return $stmt->fetchAll(PDO::FETCH_ASSOC);
    }

    private static function requiresUsernameMigration(string $username): bool
    {
        if ($username === '') {
            return true;
        }

        return strpos($username, '@') !== false;
    }

    private static function getProvidedUsername(int $userId): ?string
    {
        return self::$providedUsernames[$userId] ?? null;
    }

    /**
     * @param array<int,string> $hashColumns
     */
    private static function promptForUsername(
        int $userId,
        string $current,
        ?string $roles,
        PDO $db,
        array $hashColumns
    ): string {
        $roleList   = $roles !== null ? trim((string) $roles) : '';
        $roleLabel  = $roleList !== '' ? ' (' . $roleList . ')' : '';
        $suggestion = self::suggestUsername($current, $userId);
        while (true) {
            $prompt = 'Enter a username for user account #' . $userId . $roleLabel;
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

    private static function suggestUsername(string $current, int $userId): string
    {
        $candidate = $current;
        if (strpos($current, '@') !== false) {
            $local     = substr($current, 0, (int) strpos($current, '@'));
            $candidate = $local !== '' ? $local : 'user' . $userId;
        }
        $candidate = strtolower(preg_replace('/[^a-z0-9._-]/i', '_', $candidate));
        $candidate = trim($candidate, '._-');
        if ($candidate === '' || strlen($candidate) < 3) {
            $candidate = 'user' . $userId;
        }
        if (strlen($candidate) > 64) {
            $candidate = substr($candidate, 0, 64);
        }

        return $candidate;
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

    private static function hasInteractiveInput(): bool
    {
        if (PHP_SAPI !== 'cli') {
            return false;
        }
        if (!defined('STDIN')) {
            return false;
        }
        if (function_exists('stream_isatty')) {
            return stream_isatty(STDIN);
        }
        if (function_exists('posix_isatty')) {
            /** @var resource|string $stdin */
            $stdin = STDIN;
            return posix_isatty($stdin);
        }

        return true;
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
