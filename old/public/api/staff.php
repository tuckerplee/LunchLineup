<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/auth.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
$method  = $_SERVER['REQUEST_METHOD'];
$token   = requestParam('token');
$auth    = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}
$userId  = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}
$storeId = (int) requestParam('store_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
if ($storeId === 0) {
    jsonError('Missing store_id', 400);
}
$storeCompanyId = require_store_access($auth, $storeId);
if ($storeCompanyId !== $companyId) {
    authForbidden();
}

if ($method === 'GET') {
    if (
        !user_has_role($userId, $storeId, 'staff')
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        require_company_admin($auth, $companyId);
    }
    echo json_encode(fetchStaff($storeId, $companyId, false));
    exit;
}

if ($method === 'POST') {
    if (
        !user_has_role($userId, $storeId, 'staff')
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        require_company_admin($auth, $companyId);
    }
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid body', 400);
    }
    foreach ($payload as &$person) {
        if (is_array($person)) {
            $person['storeId'] = $storeId;
        }
    }
    unset($person);
    saveStaff($payload);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
