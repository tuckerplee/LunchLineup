<?php
declare(strict_types=1);

require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UpgradeSchemaHelper.php';

final class Upgrade20240104ShiftsBreaks
{
    public static function run(?callable $logger = null): void
    {
        $logger = self::resolveLogger($logger);
        $db      = getDb();

        if (!UpgradeSchemaHelper::tableExists($db, 'shifts')) {
            self::log($logger, 'Shifts table not found; skipping break migration.');

            return;
        }

        self::ensureBreaksColumn($db, $logger);
        self::migrateBreakData($db, $logger);
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

    private static function ensureBreaksColumn(PDO $db, callable $logger): void
    {
        if (!UpgradeSchemaHelper::columnExists($db, 'shifts', 'breaks')) {
            self::log($logger, 'Adding shifts.breaks JSON column.');
            $db->exec('ALTER TABLE `shifts` ADD COLUMN `breaks` JSON NULL AFTER `break2_duration`');
        }
    }

    private static function migrateBreakData(PDO $db, callable $logger): void
    {
        $stmt = $db->query(
            'SELECT id, breaks, break1, break1_duration, lunch, lunch_duration, break2, break2_duration FROM `shifts`'
        );
        $stmt->setFetchMode(PDO::FETCH_ASSOC);
        $update = $db->prepare('UPDATE `shifts` SET `breaks` = ? WHERE `id` = ?');
        $updated = 0;

        while ($row = $stmt->fetch()) {
            $currentBreaks = $row['breaks'] ?? null;
            if (is_string($currentBreaks) && trim($currentBreaks) !== '' && trim($currentBreaks) !== '[]') {
                continue;
            }

            $breaks = [];
            self::collectBreak($breaks, $row['break1'] ?? null, $row['break1_duration'] ?? null);
            self::collectBreak($breaks, $row['lunch'] ?? null, $row['lunch_duration'] ?? null);
            self::collectBreak($breaks, $row['break2'] ?? null, $row['break2_duration'] ?? null);

            if ($breaks === []) {
                continue;
            }

            $update->execute([json_encode($breaks, JSON_UNESCAPED_SLASHES), (int) $row['id']]);
            $updated++;
        }

        self::log($logger, 'Migrated break data for ' . $updated . ' shift records.');
    }

    private static function collectBreak(array &$breaks, mixed $start, mixed $duration): void
    {
        $startStr = trim((string) $start);
        $durationInt = is_numeric($duration) ? (int) $duration : null;

        if ($startStr === '' && ($durationInt === null || $durationInt === 0)) {
            return;
        }

        $breaks[] = [
            'start' => $startStr,
            'duration' => $durationInt ?? 0,
        ];
    }
}
