<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
$storeId = requestParam('store_id');
$storeId = $storeId !== null ? (int) $storeId : null;
if ($storeId !== null && ($storeId === 0 || get_store_company_id($storeId) !== $companyId)) {
    jsonError('Forbidden', 403);
}
require_csrf_token();
if ($method === 'GET') {
    if (isset($_GET['break']) && $storeId !== null) {
        echo json_encode(fetch_break_policy($storeId, $companyId));
    } else {
        $name = $_GET['name'] ?? '';
        if ($name === '') {
            jsonError('Missing name', 400);
        }
        $value = getSetting($name, $storeId, $companyId);
        echo json_encode(['name' => $name, 'value' => $value]);
    }
    exit;
}
if ($method === 'POST') {
    $raw     = file_get_contents('php://input');
    $payload = json_decode($raw, true);
    if (!is_array($payload)) {
        jsonError('Invalid setting', 400);
    }
    if (isset($payload['maxConcurrent'])) {
        $sid           = isset($payload['store_id']) ? (int) $payload['store_id'] : $storeId;
        if ($sid === null || $sid === 0 || get_store_company_id($sid) !== $companyId) {
            jsonError('Forbidden', 403);
        }
        $maxConcurrent = (int) ($payload['maxConcurrent'] ?? 0);
        $minSpacing    = (int) ($payload['minSpacing'] ?? 0);
        $lunchStart    = $payload['lunchStart'] ?? '';
        $lunchEnd      = $payload['lunchEnd'] ?? '';
        save_break_settings($sid, $maxConcurrent, $minSpacing, $lunchStart, $lunchEnd, $companyId);
        echo json_encode(['status' => 'ok']);
        exit;
    }
    $name  = $payload['name'] ?? '';
    $value = $payload['value'] ?? '';
    $sid   = isset($payload['store_id']) ? (int) $payload['store_id'] : $storeId;
    if ($name === '') {
        jsonError('Missing name', 400);
    }
    if ($sid !== null && ($sid === 0 || get_store_company_id($sid) !== $companyId)) {
        jsonError('Forbidden', 403);
    }
    setSetting($name, (string) $value, $sid, $companyId);
    echo json_encode(['status' => 'ok']);
    exit;
}
if ($method === 'DELETE') {
    if (isset($_GET['break']) && $storeId !== null) {
        deleteSetting('break_max_concurrent', $storeId, $companyId);
        deleteSetting('break_min_spacing', $storeId, $companyId);
        deleteSetting('lunch_window_start', $storeId, $companyId);
        deleteSetting('lunch_window_end', $storeId, $companyId);
        echo json_encode(['status' => 'ok']);
        exit;
    }
    $name = $_GET['name'] ?? '';
    if ($name === '') {
        jsonError('Missing name', 400);
    }
    deleteSetting($name, $storeId, $companyId);
    echo json_encode(['status' => 'ok']);
    exit;
}
jsonError('Method not allowed', 405);
