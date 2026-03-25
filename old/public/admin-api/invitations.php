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
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true) && empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
$isAdmin = !empty($auth['isSuperAdmin']) || is_company_admin($userId, $companyId);
if (!$isAdmin) {
    jsonError('Forbidden', 403);
}
require_csrf_token();

$templateDir = __DIR__ . '/../assets/templates';
$templates   = array_map('basename', glob($templateDir . '/*'));

if ($method === 'GET') {
    $tpl = isset($_GET['tpl']) ? basename((string) $_GET['tpl']) : '';
    if ($tpl !== '') {
        if (!in_array($tpl, $templates, true)) {
            jsonError('Template not found', 404);
        }
        $content = (string) file_get_contents($templateDir . '/' . $tpl);
        echo json_encode(['status' => 'ok', 'template' => $tpl, 'content' => $content]);
        exit;
    }
    $queue = fetch_mail_queue($companyId);
    echo json_encode(['status' => 'ok', 'queue' => $queue, 'templates' => $templates]);
    exit;
}

if ($method === 'POST') {
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        jsonError('Invalid payload', 400);
    }
    $action = $payload['action'] ?? 'invite';
    if ($action === 'save_template') {
        $tpl     = basename($payload['tpl'] ?? '');
        $content = $payload['content'] ?? '';
        if ($tpl === '') {
            jsonError('Missing template name', 400);
        }
        file_put_contents($templateDir . '/' . $tpl, $content);
        echo json_encode(['status' => 'ok']);
        exit;
    }
    if ($action === 'resend') {
        $id = (int) ($payload['id'] ?? 0);
        if ($id === 0) {
            jsonError('Missing id', 400);
        }
        update_mail_queue_status($id, 'pending');
        echo json_encode(['status' => 'ok']);
        exit;
    }
    if ($action === 'cancel') {
        $id = (int) ($payload['id'] ?? 0);
        if ($id === 0) {
            jsonError('Missing id', 400);
        }
        update_mail_queue_status($id, 'canceled');
        echo json_encode(['status' => 'ok']);
        exit;
    }
    if (empty($payload['username']) || empty($payload['storeId']) || empty($payload['role'])) {
        jsonError('Invalid invitation', 400);
    }
    $inviteeId = find_or_create_user($payload['username']);
    assign_user_store_role($inviteeId, (int) $payload['storeId'], $payload['role']);
    queueInvitation($payload['username'], (int) $payload['storeId'], $payload['role']);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
