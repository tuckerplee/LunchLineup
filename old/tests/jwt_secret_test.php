<?php
require __DIR__ . '/../src/data/core.php';
require __DIR__ . '/../src/data/jwt.php';

function assert_false($value): void
{
    if ($value !== false) {
        echo "Expected false\n";
        exit(1);
    }
}

function assert_same(string $expected, string $actual): void
{
    if ($expected !== $actual) {
        echo "Assertion failed: expected {$expected}, got {$actual}\n";
        exit(1);
    }
}

$configFile = __DIR__ . '/../config.php';
file_put_contents($configFile, "<?php return ['jwt_secret' => ''];");
putenv('JWT_SECRET');

try {
    assert_false(get_jwt_secret());

    putenv('JWT_SECRET=envsecret');
    assert_same('envsecret', get_jwt_secret());
} finally {
    if (file_exists($configFile)) {
        unlink($configFile);
    }
}

echo "JWT secret tests passed\n";
