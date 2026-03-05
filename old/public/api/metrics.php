<?php

require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$token = $_GET['token'] ?? null;
$auth  = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}
$userId = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}
if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
    jsonError('Forbidden', 403);
}
$timeframe = $_GET['timeframe'] ?? 'week';
$timeframe = $timeframe === 'month' ? 'month' : 'week';
if ($timeframe === 'month') {
    $start = new DateTimeImmutable('first day of this month');
    $end   = $start->modify('last day of this month');
} else {
    $start = new DateTimeImmutable('monday this week');
    $end   = $start->modify('+6 days');
}
$startDate = $start->format('Y-m-d');
$endDate   = $end->format('Y-m-d');
$db = getDb();
$stmt = $db->prepare(
    "SELECT DATE_FORMAT(s.date, '%x-%v') AS week, COUNT(*) AS total"
    . " FROM shifts s JOIN stores st ON st.id = s.store_id"
    . " WHERE st.company_id = ? AND s.date BETWEEN ? AND ?"
    . " GROUP BY week"
    . " ORDER BY week"
);
$stmt->execute([$companyId, $startDate, $endDate]);
$shifts = $stmt->fetchAll(PDO::FETCH_ASSOC);
$stmt = $db->prepare(
    "SELECT COUNT(*) FROM chores c JOIN stores s ON s.id = c.store_id"
    . " WHERE c.due_date BETWEEN ? AND ?"
    . " AND (c.assigned_to IS NULL OR c.assigned_to = 0)"
    . " AND s.company_id = ?"
);
$stmt->execute([$startDate, $endDate, $companyId]);
$pendingChores = (int) $stmt->fetchColumn();
echo json_encode([
    'shifts'        => $shifts,
    'pendingChores' => $pendingChores,
]);
