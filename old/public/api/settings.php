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
$storeId = requestParam('store_id');
$storeId = $storeId !== null ? (int) $storeId : null;
if ($storeId !== null && ($storeId === 0 || !in_array($storeId, $auth['stores'] ?? [], true) || get_store_company_id($storeId) !== $companyId)) {
    jsonError('Forbidden', 403);
}

if ($method === 'GET') {
    $name = $_GET['name'] ?? '';
    if ($name === '') {
        jsonError('Missing name', 400);
    }
    $value = getSetting($name, $storeId, $companyId);
    echo json_encode(['name' => $name, 'value' => $value]);
    exit;
}

if ($method === 'POST') {
if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid setting', 400);
    }
    $name  = $payload['name'] ?? '';
    $value = $payload['value'] ?? '';
    $sid   = isset($payload['store_id']) ? (int) $payload['store_id'] : $storeId;
    if ($name === '') {
        jsonError('Missing name', 400);
    }
    if ($sid !== null && ($sid === 0 || get_store_company_id($sid) !== $companyId)) {
        jsonError('Forbidden', 403);
    }
    setSetting($name, (string) $value, $sid, $companyId);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);

