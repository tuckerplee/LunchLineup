<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
    http_response_code(405);
    echo json_encode(['status' => 'error', 'message' => 'Method not allowed']);
    exit;
}
$token = requestParam('token');
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    exit;
}
$raw     = file_get_contents('php://input');
$payload  = json_decode($raw, true);
$username = $payload['username'] ?? '';
if ($username === '') {
    http_response_code(400);
    echo json_encode(['status' => 'error', 'message' => 'Invalid username']);
    exit;
}
$user = find_user_by_username($username);
if ($user) {
    create_password_reset((int) $user['id']);
}
echo json_encode(['status' => 'ok']);
