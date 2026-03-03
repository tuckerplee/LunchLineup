<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');

$token     = requestParam('token');
$auth      = verify_api_token($token);
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if (
    $auth === false
    || $companyId === 0
    || (empty($auth['isSuperAdmin']) && !is_company_admin($userId, $companyId))
) {
    jsonError('Forbidden', 403);
}

set_audit_user($userId);
set_audit_company($companyId);

$page   = isset($_GET['page']) ? max(1, (int) $_GET['page']) : 1;
$limit  = isset($_GET['per_page']) ? min(500, max(1, (int) $_GET['per_page'])) : 100;
$offset = ($page - 1) * $limit;

$db     = getDb();
$where  = ['a.company_id = :company'];
$params = [':company' => $companyId];

if (isset($_GET['user_id']) && $_GET['user_id'] !== '') {
    $where[]         = 'a.user_id = :user';
    $params[':user'] = (int) $_GET['user_id'];
}
if (isset($_GET['action']) && $_GET['action'] !== '') {
    $where[]           = 'a.action = :action';
    $params[':action'] = $_GET['action'];
}
$usernameColumn = getUserUsernameColumn();
$sql = 'SELECT a.id, a.user_id, u.' . $usernameColumn . ' AS username_value, CONCAT_WS(" ", a.action, a.entity) AS action, '
    . 'c.name AS company, s.name AS store, a.created_at '
    . 'FROM audit_logs a '
    . 'LEFT JOIN users u ON u.id = a.user_id '
    . 'LEFT JOIN companies c ON c.id = a.company_id '
    . 'LEFT JOIN stores s ON s.id = a.entity_id';
if ($where) {
    $sql .= ' WHERE ' . implode(' AND ', $where);
}
$sql .= ' ORDER BY a.created_at DESC LIMIT :limit OFFSET :offset';

$params[':limit']  = $limit;
$params[':offset'] = $offset;

$stmt = $db->prepare($sql);
foreach ($params as $key => $val) {
    $type = is_int($val) ? PDO::PARAM_INT : PDO::PARAM_STR;
    $stmt->bindValue($key, $val, $type);
}
$stmt->execute();
$logs = $stmt->fetchAll(PDO::FETCH_ASSOC);

foreach ($logs as &$row) {
    $row['username'] = isset($row['username_value'])
        ? sanitizeString(decryptField((string) $row['username_value']))
        : '';
    unset($row['username_value']);
    $row['company'] = isset($row['company']) ? sanitizeString($row['company']) : '';
    $row['store'] = isset($row['store']) ? sanitizeString($row['store']) : '';
}
unset($row);

echo json_encode($logs);
