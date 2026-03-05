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
$isSuper   = !empty($auth['isSuperAdmin']);
set_audit_user($userId);
set_audit_company($companyId);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!is_company_admin($userId, $companyId) && !$isSuper) {
    jsonError('Forbidden', 403);
}
require_csrf_token();

if ($method === 'GET') {
    $roles = fetchRoles();
    if (!$isSuper) {
        $roles = array_values(
            array_filter(
                $roles,
                function ($r) {
                    return ($r['name'] ?? '') !== 'super_admin';
                }
            )
        );
    }
    echo json_encode($roles);
    exit;
}
if ($method === 'POST') {
    $payload = json_decode(file_get_contents('php://input'), true);
    if (!is_array($payload)) {
        jsonError('Invalid role', 400);
    }
    if (!$isSuper) {
        $name = strtolower(trim($payload['name'] ?? ''));
        if ($name === 'super_admin') {
            jsonError('Forbidden', 403);
        }
        if (isset($payload['id']) && fetch_role_name((int) $payload['id']) === 'super_admin') {
            jsonError('Forbidden', 403);
        }
    }
    $id = saveRole([
        'id' => $payload['id'] ?? null,
        'name' => $payload['name'] ?? '',
        'permissions' => $payload['permissions'] ?? []
    ]);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}
if ($method === 'DELETE') {
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    if ($id === 0) {
        jsonError('Missing id', 400);
    }
    if (!$isSuper && fetch_role_name($id) === 'super_admin') {
        jsonError('Forbidden', 403);
    }
    deleteRole($id);
    echo json_encode(['status' => 'ok']);
    exit;
}
jsonError('Method not allowed', 405);
