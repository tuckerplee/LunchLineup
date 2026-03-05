<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    exit;
}
$userId = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam(
    'company_id',
    $auth['company_id'] ?? ($auth['companies'][0] ?? 1)
);
set_audit_user($userId);
set_audit_company($companyId);
require_csrf_token();

if ($method === 'GET') {
    $companies = fetchCompanies();
    echo json_encode($companies);
    exit;
}
if ($method === 'POST') {
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload) || empty($payload['name'])) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Invalid company']);
        exit;
    }
    $id = saveCompany($payload);
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
    if (!deleteCompany($id)) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Company has related records']);
        exit;
    }
    echo json_encode(['status' => 'ok']);
    exit;
}
http_response_code(405);
echo json_encode(['status' => 'error', 'message' => 'Method not allowed']);
