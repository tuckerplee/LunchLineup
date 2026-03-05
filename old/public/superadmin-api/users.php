<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UserService.php';
require_once __DIR__ . '/../../src/config.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    exit;
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
if ($companyId > 0) {
    set_audit_company($companyId);
}
require_csrf_token();
if ($method === 'GET') {
    $search = trim($_GET['search'] ?? '');
    $page   = isset($_GET['page']) ? max(1, (int) $_GET['page']) : null;
    $opts   = ['search' => $search];
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
        http_response_code(400);
        echo json_encode([
            'status'  => 'error',
            'message' => 'Missing username or home_store_id',
        ]);
        exit;
    }
    if (!isset($payload['storeIds']) || !is_array($payload['storeIds']) || count($payload['storeIds']) === 0) {
        $payload['storeIds'] = [$payload['homeStoreId']];
    }
    $homeStoreId = (int) $payload['homeStoreId'];
    if ($companyId > 0 && get_store_company_id($homeStoreId) !== $companyId) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Invalid home store']);
        exit;
    }
    $storeIds = [];
    foreach ($payload['storeIds'] as $sid) {
        $sid = (int) $sid;
        if ($companyId > 0 && get_store_company_id($sid) !== $companyId) {
            http_response_code(400);
            echo json_encode(['status' => 'error', 'message' => 'Invalid store']);
            exit;
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
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Missing id']);
        exit;
    }
    deleteUser($id);
    echo json_encode(['status' => 'ok']);
    exit;
}
http_response_code(405);
echo json_encode(['status' => 'error', 'message' => 'Method not allowed']);
