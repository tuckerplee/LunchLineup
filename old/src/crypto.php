<?php
declare(strict_types=1);

/**
 * Retrieve the application encryption key.
 *
 * The key is expected to be set in the `APP_KEY` environment variable as
 * 32 random bytes encoded with base64. The decoded value is used directly by
 * the OpenSSL functions.
 *
 * @throws RuntimeException When the key is missing or malformed.
 */
if (!function_exists('get_app_key')) {
    function get_app_key(): string
    {
        $key = $_ENV['APP_KEY'] ?? '';
        if ($key === '') {
            throw new RuntimeException('APP_KEY is not set');
        }
        $decoded = base64_decode($key, true);
        if ($decoded === false || strlen($decoded) !== 32) {
            throw new RuntimeException('APP_KEY must be a base64-encoded 256-bit key');
        }

        return $decoded;
    }
}

/**
 * Encrypt a plaintext field using AES-256-CBC.
 *
 * @param string $plaintext The value to encrypt.
 * @return string Base64-encoded IV and ciphertext.
 * @throws RuntimeException When encryption fails.
 */
if (!function_exists('encryptField')) {
    function encryptField(string $plaintext): string
    {
        $key = get_app_key();
        $iv = random_bytes(16);
        $ciphertext = openssl_encrypt($plaintext, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
        if ($ciphertext === false) {
            throw new RuntimeException('Unable to encrypt data');
        }

        return base64_encode($iv . $ciphertext);
    }
}

/**
 * Decrypt a ciphertext field previously produced by {@see encryptField()}.
 *
 * Falls back to returning the original string when the value is not valid
 * encrypted data, allowing plaintext fields from older records.
 *
 * @param string $ciphertext Base64-encoded IV and ciphertext or plaintext.
 * @return string Decrypted plaintext value.
 * @throws RuntimeException When the application key is missing or malformed.
 */
if (!function_exists('decryptField')) {
    function decryptField(string $ciphertext): string
    {
        $key = get_app_key();
        $data = base64_decode($ciphertext, true);
        if ($data === false || strlen($data) < 17) {
            return $ciphertext;
        }
        $iv = substr($data, 0, 16);
        $cipher = substr($data, 16);
        $plaintext = openssl_decrypt($cipher, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
        if ($plaintext === false) {
            return $ciphertext;
        }

        return $plaintext;
    }
}

/**
 * Generate a lowercase SHA-256 hash of a username for lookups.
 */
if (!function_exists('usernameHash')) {
    function usernameHash(string $username): string
    {
        return hash('sha256', strtolower($username));
    }
}
