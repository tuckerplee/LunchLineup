<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/print_schedule.php';

header('Content-Type: application/json');

if ($_SERVER['REQUEST_METHOD'] !== 'POST') {
    jsonError('Method not allowed', 405);
}

$token = requestParam('token');
$auth  = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}

$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
$storeId   = (int) requestParam('store_id', 0);

if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}

if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}

if ($storeId === 0) {
    jsonError('Missing store_id', 400);
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
    && !user_has_role($userId, $storeId, 'chores')
    && !isAdmin($userId)
) {
    jsonError('Forbidden', 403);
}

set_audit_user($userId);
set_audit_company($companyId);

$payload = read_json_body();
if (!is_array($payload)) {
    jsonError('Invalid payload', 400);
}

$date = isset($payload['date']) && is_string($payload['date'])
    ? $payload['date']
    : date('Y-m-d');
if (!is_string($date) || preg_match('/^\d{4}-\d{2}-\d{2}$/', $date) !== 1) {
    $date = date('Y-m-d');
}

$employees = [];
if (isset($payload['employees']) && is_array($payload['employees'])) {
    foreach ($payload['employees'] as $index => $employee) {
        if (!is_array($employee)) {
            $employee = [];
        }
        $employee['tasks'] = isset($employee['tasks']) && is_array($employee['tasks'])
            ? array_values($employee['tasks'])
            : [];
        $employees[] = $employee + ['index' => $index];
    }
}

$scheduleDay = ['employees' => $employees];
assignChoresToSchedule($scheduleDay, $storeId, $date);

$result = [];
foreach ($scheduleDay['employees'] as $idx => $employee) {
    $tasks = [];
    if (isset($employee['tasks']) && is_array($employee['tasks'])) {
        foreach ($employee['tasks'] as $task) {
            if (is_array($task)) {
                $description = isset($task['description'])
                    ? trim((string) $task['description'])
                    : '';
                if ($description === '') {
                    continue;
                }
                $type = isset($task['type']) && is_string($task['type']) && $task['type'] !== ''
                    ? $task['type']
                    : 'chore';
                $tasks[] = [
                    'description' => $description,
                    'type'        => $type,
                ];
            } elseif (is_string($task)) {
                $description = trim($task);
                if ($description !== '') {
                    $tasks[] = [
                        'description' => $description,
                        'type'        => 'chore',
                    ];
                }
            }
        }
    }

    $result[] = [
        'index' => $idx,
        'id'    => isset($employee['id']) ? (int) $employee['id'] : null,
        'tasks' => $tasks,
    ];
}

echo json_encode(['employees' => $result]);
