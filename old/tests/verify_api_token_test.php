<?php
require __DIR__ . '/../src/data/core.php';
require __DIR__ . '/../src/data/jwt.php';

function assert_false($value): void {
    if ($value !== false) {
        echo "Expected false\n";
        exit(1);
    }
}

$configFile = __DIR__ . '/../config.php';
file_put_contents($configFile, "<?php return ['jwt_secret' => ''];");
putenv('JWT_SECRET');

try {
    $token = 'a.b.c';
    $result = verify_api_token($token);
    assert_false($result);
} finally {
    if (file_exists($configFile)) {
        unlink($configFile);
    }
}

echo "verify_api_token tests passed\n";
