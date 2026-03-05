<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    jsonError('Method not allowed', 405);
}
 $token = requestParam('token');
 $auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
$raw     = file_get_contents('php://input');
$payload  = json_decode($raw, true);
$username = $payload['username'] ?? '';
if ($username === '') {
    jsonError('Invalid username', 400);
}
$user = find_user_by_username($username);
if ($user) {
    create_password_reset((int) $user['id']);
}
echo json_encode(['status' => 'ok']);
