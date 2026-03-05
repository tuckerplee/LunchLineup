<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    exit;
}
set_audit_user((int) ($auth['sub'] ?? 0));

if ($method === 'POST') {
    initDb();
    auditLog('rebuild', 'schema');
    echo json_encode(['status' => 'ok']);
    exit;
}
http_response_code(405);
echo json_encode(['status' => 'error', 'message' => 'Method not allowed']);

