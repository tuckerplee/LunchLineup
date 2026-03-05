<?php
require_once __DIR__ . '/../../src/data.php';

$auth = verify_api_token($_GET['token'] ?? null);
if ($auth === false) {
    jsonError('Invalid token', 403);
}

$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id']
    : ($auth['company_id'] ?? (count($auth['companies'] ?? []) === 1 ? (int) $auth['companies'][0] : 0));
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}

$storeId = isset($_GET['store_id']) ? (int) $_GET['store_id'] : 0;
if ($storeId === 0 || !in_array($storeId, $auth['stores'] ?? [], true) || get_store_company_id($storeId) !== $companyId) {
    jsonError('Forbidden', 403);
}
header('Content-Type: application/json');
echo json_encode(fetchSchedule($storeId));
