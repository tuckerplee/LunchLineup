<?php
if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    $password = $argv[1] ?? '';
    if ($password === '') {
        fwrite(STDERR, "Usage: php hash_password.php <password>\n");
        exit(1);
    }
    echo password_hash($password, PASSWORD_DEFAULT) . PHP_EOL;
}
