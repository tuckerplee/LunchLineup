<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method  = $_SERVER['REQUEST_METHOD'];
$token   = requestParam('token');
$auth    = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}
$userId  = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}
$storeId = (int) requestParam('store_id', 0);
if ($storeId === 0) {
    jsonError('Missing store_id', 400);
}
$storeCompanyId = get_store_company_id($storeId);
$hasStoreAccess = in_array($storeId, $auth['stores'] ?? [], true);
if (
    $storeCompanyId !== $companyId
    || (
        !$hasStoreAccess
        && empty($auth['isSuperAdmin'])
        && !is_company_admin($userId, $companyId)
    )
) {
    jsonError('Forbidden', 403);
}

if ($method === 'GET') {
    if (
        empty($auth['isSuperAdmin'])
        && !is_company_admin($userId, $companyId)
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        jsonError('Forbidden', 403);
    }
    $data = fetchSchedule($storeId);
    echo json_encode($data);
    exit;
}

if ($method === 'POST') {
    if (
        empty($auth['isSuperAdmin'])
        && !is_company_admin($userId, $companyId)
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        jsonError('Forbidden', 403);
    }
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid schedule', 400);
    }
    foreach ($payload as &$day) {
        if (isset($day['employees']) && is_array($day['employees'])) {
            foreach ($day['employees'] as &$emp) {
                if (is_array($emp)) {
                    $emp['storeId'] = $storeId;
                }
            }
            unset($emp);
        }
    }
    unset($day);
    saveSchedule($payload, $storeId);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
