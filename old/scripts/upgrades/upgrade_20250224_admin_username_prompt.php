<?php
declare(strict_types=1);

require_once __DIR__ . '/upgrade_20250221_admin_username_prompt.php';

final class Upgrade20250224AdminUsernamePrompt
{
    public static function run(?callable $logger = null): void
    {
        $logger = $logger ?? static function (string $message): void {
            echo $message . PHP_EOL;
        };

        $logger('Re-running account username prompt to capture outstanding migrations.');
        Upgrade20250221AdminUsernamePrompt::run($logger);
        $logger('Account username prompt re-run complete.');
    }
}
