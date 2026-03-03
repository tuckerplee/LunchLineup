<?php
declare(strict_types=1);

function get_jwt_secret(): string|false
{
    static $secret = null;
    if ($secret !== null) {
        return $secret;
    }
    $env = getenv('JWT_SECRET');
    if ($env !== false && $env !== '') {
        $secret = $env;
        return $secret;
    }
    $config = getConfig();
    if (isset($config['jwt_secret']) && $config['jwt_secret'] !== '') {
        $secret = $config['jwt_secret'];
        return $secret;
    }
    return false;
}

function base64url_encode(string $data): string
{
    return rtrim(strtr(base64_encode($data), '+/', '-_'), '=');
}

function base64url_decode(string $data): string
{
    $remainder = strlen($data) % 4;
    if ($remainder) {
        $data .= str_repeat('=', 4 - $remainder);
    }
    return base64_decode(strtr($data, '-_', '+/')) ?: '';
}

function createJwt(array $payload): string|false
{
    $secret = get_jwt_secret();
    if ($secret === false) {
        return false;
    }

    $header = ['alg' => 'HS256', 'typ' => 'JWT'];
    $segments = [
        base64url_encode(json_encode($header)),
        base64url_encode(json_encode($payload)),
    ];
    $signature = hash_hmac('sha256', implode('.', $segments), $secret, true);
    $segments[] = base64url_encode($signature);
    return implode('.', $segments);
}

function verify_api_token(?string $provided): array|false
{
    if ($provided === null) {
        return false;
    }
    $parts = explode('.', $provided);
    if (count($parts) !== 3) {
        return false;
    }
    [$h64, $p64, $s64] = $parts;
    $sig = base64url_decode($s64);
    $secret = get_jwt_secret();
    if ($secret === false) {
        return false;
    }
    $check = hash_hmac('sha256', "$h64.$p64", $secret, true);
    if (!hash_equals($check, $sig)) {
        return false;
    }
    $payload = json_decode(base64url_decode($p64), true);
    if (!is_array($payload)) {
        return false;
    }
    if (isset($payload['exp']) && time() >= (int) $payload['exp']) {
        return false;
    }
    if (isset($payload['companies'])) {
        if (!is_array($payload['companies'])) {
            return false;
        }
        $payload['companies'] = array_values(array_map('intval', $payload['companies']));
        if ($payload['companies'] === []) {
            return false;
        }
        if (count($payload['companies']) === 1) {
            $payload['company_id'] = $payload['companies'][0];
        }
    } elseif (isset($payload['company_id'])) {
        $payload['company_id'] = (int) $payload['company_id'];
        $payload['companies']   = [$payload['company_id']];
    } else {
        return false;
    }
    return $payload;
}

