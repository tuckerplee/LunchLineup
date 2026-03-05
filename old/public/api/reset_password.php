<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonError('Method not allowed', 405);
}

$payload = read_json_body();
$token = $payload['token'] ?? '';
$password = $payload['password'] ?? '';
if ($token === '' || $password === '') {
    jsonError('Invalid request', 400);
}
if (reset_password_with_token($token, $password)) {
    echo json_encode(['status' => 'ok']);
    exit;
}
jsonError('Invalid token', 400);
