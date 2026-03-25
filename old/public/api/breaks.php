<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/breaks.php';

header('Content-Type: application/json');
if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonError('Method not allowed', 405);
}

$token     = requestParam('token');
$auth      = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
$storeId   = (int) requestParam('store_id', 0);
set_audit_user($userId);
set_audit_company($companyId);
if ($companyId === 0 || $storeId === 0) {
    jsonError('Missing company_id or store_id', 400);
}
$storeCompanyId = get_store_company_id($storeId);
$hasStoreAccess = in_array($storeId, $auth['stores'] ?? [], true);
if (
    $storeCompanyId !== $companyId
    || (
        !$hasStoreAccess
        && empty($auth['isSuperAdmin'])
        && !is_company_admin($userId, $companyId)
    )
) {
    jsonError('Forbidden', 403);
}
if (
    empty($auth['isSuperAdmin'])
    && !is_company_admin($userId, $companyId)
    && !user_has_role($userId, $storeId, 'schedule')
    && !isAdmin($userId)
) {
    jsonError('Forbidden', 403);
}

$payload = read_json_body();
if (!is_array($payload)) {
    jsonError('Invalid payload', 400);
}
$start  = isset($payload['start']) ? (float) $payload['start'] : null;
$end    = isset($payload['end']) ? (float) $payload['end'] : null;
$policy = isset($payload['policy']) && is_array($payload['policy']) ? $payload['policy'] : [];
$others = isset($payload['others']) && is_array($payload['others']) ? $payload['others'] : [];
if ($start === null || $end === null) {
    jsonError('Missing start or end', 400);
}

$result = calculateBreaks($start, $end, $policy, $others);
echo json_encode($result);
