<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}
$userId = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}
require_csrf_token();

if ($method === 'POST') {
    if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
        jsonError('Forbidden', 403);
    }
    $payload = read_json_body();
    if (
        !is_array($payload)
        || empty($payload['username'])
        || empty($payload['storeId'])
        || empty($payload['role'])
    ) {
        jsonError('Invalid invitation', 400);
    }
    $inviteeId = find_or_create_user($payload['username']);
    assign_user_store_role($inviteeId, (int) $payload['storeId'], $payload['role']);
    queueInvitation($payload['username'], (int) $payload['storeId'], $payload['role']);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
