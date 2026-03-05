<?php
declare(strict_types=1);

require_once __DIR__ . '/data.php';

final class UpgradeCoordinator
{
    public static function runPending(?callable $logger = null): array
    {
        $db = getDb();
        self::ensureSchemaMigrationsTable($db);
        $upgrades = self::loadUpgradeScripts();
        $results = [];
        $halt    = false;

        foreach ($upgrades as $upgrade) {
            $result = [
                'id'       => $upgrade['id'],
                'name'     => $upgrade['name'],
                'status'   => 'skipped',
                'messages' => [],
            ];

            if ($halt) {
                $result['status']     = 'pending';
                $result['messages'][] = 'Skipped because a previous upgrade failed.';
                $results[]            = $result;
                continue;
            }

            if (self::hasMigration($db, $upgrade['id'])) {
                $message = 'Already applied.';
                $result['messages'][] = $message;
                if ($logger !== null) {
                    $logger($upgrade['id'] . ': ' . $message);
                }
                $results[] = $result;
                continue;
            }

            $collector = static function (string $message) use (&$result, $logger, $upgrade): void {
                $result['messages'][] = $message;
                if ($logger !== null) {
                    $logger($upgrade['id'] . ': ' . $message);
                }
            };

            try {
                ($upgrade['runner'])($collector);
                self::recordMigration($db, $upgrade['id']);
                $result['status']     = 'applied';
                $result['messages'][] = 'Upgrade applied successfully.';
                auditLog('run', 'upgrade:' . $upgrade['id']);
                if ($logger !== null) {
                    $logger($upgrade['id'] . ': Upgrade applied successfully.');
                }
            } catch (Throwable $exception) {
                $result['status']     = 'failed';
                $result['messages'][] = 'Error: ' . $exception->getMessage();
                $result['error']      = $exception->getMessage();
                auditLog('fail', 'upgrade:' . $upgrade['id']);
                if ($logger !== null) {
                    $logger($upgrade['id'] . ': Error: ' . $exception->getMessage());
                }
                $halt = true;
            }

            $results[] = $result;
        }

        return $results;
    }

    private static function ensureSchemaMigrationsTable(PDO $db): void
    {
        $db->exec(
            'CREATE TABLE IF NOT EXISTS schema_migrations ('
            . ' id INT UNSIGNED AUTO_INCREMENT PRIMARY KEY,'
            . ' migration VARCHAR(255) NOT NULL UNIQUE,'
            . ' executed_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP'
            . ' ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4'
        );
    }

    private static function loadUpgradeScripts(): array
    {
        $directory = __DIR__ . '/../scripts/upgrades';
        if (!is_dir($directory)) {
            return [];
        }

        $files = glob($directory . '/*.php');
        sort($files);

        $upgrades = [];
        foreach ($files as $file) {
            $identifier = basename($file, '.php');
            require_once $file;
            $upgrades[] = [
                'id'     => $identifier,
                'name'   => self::humanize($identifier),
                'runner' => self::resolveRunner($identifier, $file),
            ];
        }

        return $upgrades;
    }

    private static function resolveRunner(string $identifier, string $file): callable
    {
        $className = self::classNameFromIdentifier($identifier);
        if (class_exists($className)) {
            return static function (?callable $logger = null) use ($className): void {
                if ($logger !== null) {
                    $className::run($logger);

                    return;
                }

                $className::run();
            };
        }

        throw new RuntimeException(
            'Upgrade file "' . basename($file) . '" must declare a class named ' . $className . ' with a public static run() method.'
        );
    }

    private static function classNameFromIdentifier(string $identifier): string
    {
        $parts = preg_split('/[_-]+/', $identifier);
        $parts = array_map(static fn (string $part): string => ucfirst($part), $parts ?: []);

        return implode('', $parts);
    }

    private static function humanize(string $identifier): string
    {
        $parts = preg_split('/[_-]+/', $identifier);
        $parts = array_map(static fn (string $part): string => ucfirst($part), $parts ?: []);

        return implode(' ', $parts);
    }

    private static function hasMigration(PDO $db, string $identifier): bool
    {
        $stmt = $db->prepare('SELECT 1 FROM schema_migrations WHERE migration = ? LIMIT 1');
        $stmt->execute([$identifier]);

        return (bool) $stmt->fetchColumn();
    }

    private static function recordMigration(PDO $db, string $identifier): void
    {
        $stmt = $db->prepare('INSERT INTO schema_migrations (migration) VALUES (?)');
        $stmt->execute([$identifier]);
    }
}
