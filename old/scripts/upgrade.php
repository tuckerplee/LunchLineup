#!/usr/bin/env php
<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/upgrade.php';

$logger = static function (string $message): void {
    fwrite(STDOUT, $message . PHP_EOL);
};

try {
    $results = UpgradeCoordinator::runPending($logger);
    $hasFailures = false;
    foreach ($results as $result) {
        if (($result['status'] ?? '') === 'failed') {
            $hasFailures = true;
        }
    }
    if ($hasFailures) {
        exit(1);
    }
    exit(0);
} catch (Throwable $exception) {
    fwrite(STDERR, 'Upgrade failed: ' . $exception->getMessage() . PHP_EOL);
    exit(1);
}
