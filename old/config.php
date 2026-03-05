<?php

$envFile = __DIR__ . '/.env';
if (is_readable($envFile)) {
    $vars = parse_ini_file($envFile, false, INI_SCANNER_RAW);
    if (is_array($vars)) {
        foreach ($vars as $key => $value) {
            if (!isset($_ENV[$key]) && getenv($key) === false) {
                $_ENV[$key] = $value;
                putenv($key . '=' . $value);
            }
        }
    }
}

return [
    'host' => $_ENV['DB_HOST'] ?? getenv('DB_HOST'),
    'user' => $_ENV['DB_USER'] ?? getenv('DB_USER'),
    'pass' => $_ENV['DB_PASS'] ?? getenv('DB_PASS'),
    'dbname' => $_ENV['DB_NAME'] ?? getenv('DB_NAME'),
    'jwt_secret' => $_ENV['JWT_SECRET'] ?? getenv('JWT_SECRET'),
    'app_key' => $_ENV['APP_KEY'] ?? getenv('APP_KEY'),
    'backup_dir' => $_ENV['BACKUP_DIR'] ?? getenv('BACKUP_DIR') ?? (__DIR__ . '/public/backups'),
    'debug' => [
        'enabled' => filter_var($_ENV['DEBUG'] ?? getenv('DEBUG') ?? false, FILTER_VALIDATE_BOOLEAN),
        'allowed_ips' => array_values(
            array_filter(
                array_map('trim', explode(',', $_ENV['DEBUG_ALLOWED_IPS'] ?? getenv('DEBUG_ALLOWED_IPS') ?? ''))
            )
        ),
    ],
];

