<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false) {
    jsonError('Forbidden', 403);
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
$isSuper   = !empty($auth['isSuperAdmin']);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!$isSuper && !is_company_admin($userId, $companyId)) {
    jsonError('Forbidden', 403);
}
require_csrf_token();
if ($method === 'GET') {
    $search = trim($_GET['search'] ?? '');
    $page   = isset($_GET['page']) ? max(1, (int) $_GET['page']) : null;
    if ($search !== '' || $page !== null) {
        $limit  = 10;
        $page   = $page ?? 1;
        $offset = ($page - 1) * $limit;
        $db     = getDb();
        $sql    = 'SELECT id, name, location FROM stores WHERE company_id = :company';
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
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        jsonError('Invalid store', 400);
    }
    $id = saveStore($payload, $companyId);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}
if ($method === 'DELETE') {
    $storeId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if ($storeId === 0) {
        jsonError('Missing id', 400);
    }
    if (get_store_company_id($storeId) !== $companyId) {
        jsonError('Forbidden', 403);
    }
    deleteStore($storeId);
    echo json_encode(['status' => 'ok']);
    exit;
}
jsonError('Method not allowed', 405);
