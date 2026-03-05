<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/UserService.php';

header('Content-Type: application/json');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    jsonError('Method not allowed', 405);
}
$token = requestParam('token');
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
require_csrf_token();
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
$type   = requestParam('type', '');
$format = strtolower(requestParam('format', ''));
$upload = $_FILES['file'] ?? null;
if ($upload && $format === '') {
    $format = strtolower(pathinfo($upload['name'], PATHINFO_EXTENSION));
}
if (!$upload || ($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    jsonError('Missing file', 400);
}
if ($format !== 'json' && $format !== 'csv') {
    jsonError('Invalid format', 400);
}
$content = file_get_contents($upload['tmp_name']);
if ($content === false) {
    jsonError('Failed to read upload', 500);
}
if ($format === 'json') {
    $data = json_decode($content, true);
    if (!is_array($data)) {
        jsonError('Invalid JSON', 400);
    }
} else {
    $fh    = fopen($upload['tmp_name'], 'r');
    $header = $fh !== false ? fgetcsv($fh) : false;
    $data   = [];
    if (is_array($header)) {
        while (($row = fgetcsv($fh)) !== false) {
            $data[] = array_combine($header, $row);
        }
    }
    if ($fh !== false) {
        fclose($fh);
    }
}
switch ($type) {
    case 'staff':
        saveStaff($data);
        $count = count($data);
        break;
    case 'users':
        $count   = 0;
        $service = new UserService();
        foreach ($data as $user) {
            $user['companyId'] = $companyId;
            $service->save($user);
            $count++;
        }
        break;
    case 'stores':
        $count = 0;
        foreach ($data as $store) {
            saveStore($store, $companyId);
            $count++;
        }
        break;
    default:
        jsonError('Invalid type', 400);
}
echo json_encode(['status' => 'ok', 'count' => $count]);
