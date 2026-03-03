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
        && !user_has_role($userId, $storeId, 'chores')
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        jsonError('Forbidden', 403);
    }
    echo json_encode(fetchChores($storeId));
    exit;
}

if ($method === 'POST') {
    if (
        empty($auth['isSuperAdmin'])
        && !is_company_admin($userId, $companyId)
        && !user_has_role($userId, $storeId, 'chores')
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        jsonError('Forbidden', 403);
    }
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid chore', 400);
    }
    if (array_is_list($payload)) {
        foreach ($payload as &$chore) {
            if (is_array($chore)) {
                $chore['storeId'] = $storeId;
            }
        }
        unset($chore);
        saveChores($payload, $storeId);
    } else {
        $current = fetchChores($storeId);
        $found   = false;
        foreach ($current as &$chore) {
            if ((int) ($chore['id'] ?? 0) === (int) ($payload['id'] ?? 0)) {
                $chore = array_merge($chore, $payload);
                $found = true;
                break;
            }
        }
        if (!$found) {
            $payload['storeId'] = $storeId;
            $current[] = $payload;
        }
        saveChores($current, $storeId);
    }
    echo json_encode(['status' => 'ok']);
    exit;
}

if ($method === 'DELETE') {
    if (
        empty($auth['isSuperAdmin'])
        && !is_company_admin($userId, $companyId)
        && !user_has_role($userId, $storeId, 'chores')
        && !user_has_role($userId, $storeId, 'schedule')
        && !isAdmin($userId)
    ) {
        jsonError('Forbidden', 403);
    }
    $body = read_json_body();
    $id   = requestParam('id', $body['id'] ?? null);
    $id   = is_numeric($id) ? (int) $id : null;
    if ($id === null) {
        jsonError('Missing id', 400);
    }
    deleteChore($id, $storeId);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
