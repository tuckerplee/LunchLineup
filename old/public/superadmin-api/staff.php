<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/auth.php';
require_once __DIR__ . '/../../src/StaffService.php';

header('Content-Type: application/json');
$method    = $_SERVER['REQUEST_METHOD'];
$token     = requestParam('token');
$auth      = verify_api_token($token);
$companyId = (int) requestParam('company_id', 0);
if ($auth === false) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    exit;
}
$userId = (int) ($auth['sub'] ?? 0);
require_company_admin($auth, $companyId);
set_audit_user($userId);
if ($companyId > 0) {
    set_audit_company($companyId);
}
require_csrf_token();

if ($method === 'GET') {
    $search        = trim($_GET['search'] ?? '');
    $pageParam     = $_GET['page'] ?? null;
    $page          = $pageParam !== null && $pageParam !== '' ? max(1, (int) $pageParam) : null;
    $perPageParam  = $_GET['per_page'] ?? ($_GET['limit'] ?? '');
    $perPage       = null;
    if ($page !== null) {
        $perPage = (int) $perPageParam;
        if ($perPage <= 0) {
            $perPage = 50;
        }
        $perPage = min($perPage, 100);
    }
    $includeAdmins = filter_var(requestParam('includeAdmins', false), FILTER_VALIDATE_BOOLEAN);
    $staff         = fetchStaff(null, $companyId, $includeAdmins);
    if ($search !== '') {
        $staff = array_values(array_filter(
            $staff,
            function ($s) use ($search) {
                return stripos($s['name'], $search) !== false;
            }
        ));
    }
    if ($page !== null) {
        $total  = count($staff);
        header('X-Total-Count: ' . $total);
        header('X-Page: ' . $page);
        header('X-Per-Page: ' . $perPage);
        $offset = ($page - 1) * $perPage;
        $staff  = array_slice($staff, $offset, $perPage);
    }
    echo json_encode($staff);
    exit;
}

if ($method === 'POST') {
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Invalid staff']);
        exit;
    }
    if ($companyId > 0) {
        $payload['companyId'] = $companyId;
    }
    if (empty($payload['companyId'])) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Missing companyId']);
        exit;
    }
    $cid = (int) $payload['companyId'];
    if (!empty($payload['storeId'])) {
        $sid = (int) $payload['storeId'];
        if (get_store_company_id($sid) !== $cid) {
            http_response_code(403);
            echo json_encode(['status' => 'error', 'message' => 'Invalid store']);
            exit;
        }
    }
    $service = new StaffService();
    $id      = $service->save($payload);
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
    deleteStaff($id);
    echo json_encode(['status' => 'ok']);
    exit;
}

http_response_code(405);
echo json_encode(['status' => 'error', 'message' => 'Method not allowed']);

