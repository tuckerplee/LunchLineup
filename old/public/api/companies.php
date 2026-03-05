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
$companyId = (int) requestParam(
    'company_id',
    $auth['company_id'] ?? ($auth['companies'][0] ?? 1)
);
set_audit_user($userId);
set_audit_company($companyId);
if (!is_super_admin($userId)) {
    jsonError('Forbidden', 403);
}
require_csrf_token();

if ($method === 'GET') {
    echo json_encode(fetchCompanies());
    exit;
}

if ($method === 'POST') {
    $payload = read_json_body();
    if (!is_array($payload) || empty($payload['name'])) {
        jsonError('Invalid company', 400);
    }
    $id = saveCompany($payload);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}

if ($method === 'DELETE') {
    $id = (int) requestParam('id', 0);
    if ($id === 0) {
        jsonError('Missing id', 400);
    }
    if (!deleteCompany($id)) {
        jsonError('Company has related records', 400);
    }
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
