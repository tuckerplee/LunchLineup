<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/auth.php';
require_once __DIR__ . '/../../src/UserService.php';
require_once __DIR__ . '/../../src/config.php';

header('Content-Type: application/json');
header('Cache-Control: no-store, no-cache, must-revalidate');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false) {
    jsonError('Forbidden', 403);
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
if ($companyId > 0) {
    set_audit_company($companyId);
}
$hasAdminRole = user_has_company_role($userId, $companyId, 'company_admin')
    || user_has_company_role($userId, $companyId, 'super_admin');
if ($companyId === 0 || (!$hasAdminRole && empty($auth['isSuperAdmin']))) {
    jsonError('Forbidden', 403);
}
require_csrf_token();
if ($method === 'GET') {
    $search = trim($_GET['search'] ?? '');
    $page   = isset($_GET['page']) ? max(1, (int) $_GET['page']) : null;
    $admins = filter_var($_GET['admins'] ?? false, FILTER_VALIDATE_BOOLEAN);
    $opts   = ['search' => $search, 'admins' => $admins];
    if ($page !== null) {
        $opts['page']  = $page;
        $opts['limit'] = DEFAULT_PAGE_SIZE;
    }
    $rows = fetch_company_users($companyId, $opts);
    echo json_encode($rows);
    exit;
}
if ($method === 'POST') {
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (
        !is_array($payload)
        || empty($payload['username'])
        || empty($payload['homeStoreId'])
    ) {
        jsonError('Missing username or home_store_id', 400);
    }
    if (!isset($payload['storeIds']) || !is_array($payload['storeIds']) || count($payload['storeIds']) === 0) {
        $payload['storeIds'] = [$payload['homeStoreId']];
    }
    $homeStoreId = (int) $payload['homeStoreId'];
    if ($companyId > 0 && get_store_company_id($homeStoreId) !== $companyId) {
        jsonError('Invalid home store', 400);
    }
    $storeIds = [];
    foreach ($payload['storeIds'] as $sid) {
        $sid = (int) $sid;
        if ($companyId > 0 && get_store_company_id($sid) !== $companyId) {
            jsonError('Invalid store', 400);
        }
        $storeIds[] = $sid;
    }
    if (!in_array($homeStoreId, $storeIds, true)) {
        $storeIds[] = $homeStoreId;
    }
    if ($companyId > 0) {
        $payload['companyId'] = $companyId;
    }
    $payload['storeIds'] = $storeIds;
    $service             = new UserService();
    $id                  = $service->save($payload);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}
if ($method === 'DELETE') {
    $id = (int) requestParam('id', 0);
    if ($id === 0) {
        jsonError('Missing id', 400);
    }
    deleteUser($id);
    echo json_encode(['status' => 'ok']);
    exit;
}
jsonError('Method not allowed', 405);
