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
if (!in_array($companyId, $auth['companies'] ?? [], true) && empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
require_csrf_token();

if ($method === 'GET') {
if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}

    $search = trim($_GET['search'] ?? '');
    $page = isset($_GET['page']) ? max(1, (int) $_GET['page']) : null;
    if ($search !== '' || $page !== null) {
        $limit = 10;
        $page = $page ?? 1;
        $offset = ($page - 1) * $limit;
        $db = getDb();
        $sql = 'SELECT id, name, location FROM stores WHERE company_id = :company';
        if ($search !== '') {
            $sql .= ' AND name LIKE :search';
        }
        $sql .= ' ORDER BY id LIMIT :limit OFFSET :offset';
        $stmt = $db->prepare($sql);
        $stmt->bindValue(':company', $companyId, PDO::PARAM_INT);
        if ($search !== '') {
            $stmt->bindValue(':search', '%' . $search . '%');
        }
        $stmt->bindValue(':limit', $limit, PDO::PARAM_INT);
        $stmt->bindValue(':offset', $offset, PDO::PARAM_INT);
        $stmt->execute();
        echo json_encode($stmt->fetchAll(PDO::FETCH_ASSOC));
    } else {
        echo json_encode(fetchStores($companyId));
    }
    exit;
}

if ($method === 'POST') {
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid store', 400);
    }
    $storeId = isset($payload['id']) ? (int) $payload['id'] : 0;
    if ($storeId === 0) {
        if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
            jsonError('Forbidden', 403);
        }
    } elseif (empty($auth['isSuperAdmin']) && !is_company_admin($userId, $companyId) && !user_has_role($userId, $storeId, 'store')) {
        jsonError('Forbidden', 403);
    }
    if ($storeId !== 0 && get_store_company_id($storeId) !== $companyId) {
        jsonError('Forbidden', 403);
    }
    $id = saveStore($payload, $companyId);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}

if ($method === 'DELETE') {
    $storeId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
        jsonError('Forbidden', 403);
    }
    if ($storeId === 0 || get_store_company_id($storeId) !== $companyId) {
        jsonError('Forbidden', 403);
    }
    deleteStore($storeId);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
