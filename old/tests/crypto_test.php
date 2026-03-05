<?php
declare(strict_types=1);

require_once __DIR__ . '/../src/crypto.php';

function assert_same($expected, $actual, string $msg = ''): void
{
    if ($expected !== $actual) {
        echo "Assertion failed: {$msg}\n";
        exit(1);
    }
}

$rawKey    = str_repeat('K', 32);
$encodedKey = base64_encode($rawKey);
putenv('APP_KEY=' . $encodedKey);
$_ENV['APP_KEY'] = $encodedKey;

assert_same($rawKey, get_app_key(), 'app key');

$plain = 'top secret';
$cipher = encryptField($plain);
assert_same($plain, decryptField($cipher), 'round trip');

$malformed = base64_encode('short');
assert_same($malformed, decryptField($malformed), 'malformed ciphertext');

echo "crypto tests passed\n";
