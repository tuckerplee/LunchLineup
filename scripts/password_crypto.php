<?php
declare(strict_types=1);

/**
 * Encrypt plaintext using a password-derived key with AES-256-CBC.
 */
function encrypt_with_password(string $plaintext, string $password): string
{
    $key = hash('sha256', $password, true);
    $iv = random_bytes(16);
    $cipher = openssl_encrypt($plaintext, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    if ($cipher === false) {
        throw new RuntimeException('Unable to encrypt data');
    }
    return base64_encode($iv . $cipher);
}

/**
 * Decrypt a ciphertext produced by {@see encrypt_with_password()}.
 * Returns the original string when the data is not valid ciphertext.
 */
function decrypt_with_password(string $ciphertext, string $password): string
{
    $data = base64_decode($ciphertext, true);
    if ($data === false || strlen($data) < 17) {
        return $ciphertext;
    }
    $iv = substr($data, 0, 16);
    $cipher = substr($data, 16);
    $key = hash('sha256', $password, true);
    $plaintext = openssl_decrypt($cipher, 'aes-256-cbc', $key, OPENSSL_RAW_DATA, $iv);
    if ($plaintext === false) {
        return $ciphertext;
    }
    return $plaintext;
}
