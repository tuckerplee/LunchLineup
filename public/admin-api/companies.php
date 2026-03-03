<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
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
    foreach ($companies as &$company) {
        $company['dashboardUrl'] = '../admin/company_dashboard.php?company_id=' . $company['id'];
    }
    echo json_encode($companies);
    exit;
}
if ($method === 'POST') {
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
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
