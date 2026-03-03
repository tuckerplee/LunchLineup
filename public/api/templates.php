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
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}

if ($method === 'GET') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if ($id > 0) {
        $tpl = fetch_schedule_template($id);
        if ($tpl === null) {
            jsonError('Not found', 404);
        } else {
            echo json_encode($tpl);
        }
    } else {
        echo json_encode(fetch_schedule_templates());
    }
    exit;
}

if ($method === 'POST') {
    if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
        jsonError('Forbidden', 403);
    }
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid template', 400);
    }
    $id = save_schedule_template($payload);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}

if ($method === 'DELETE') {
    if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
        jsonError('Forbidden', 403);
    }
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    delete_schedule_template($id);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
