<?php
require_once __DIR__ . '/../../src/data.php';

$token = requestParam('token');
$auth  = verify_api_token($token);
if ($auth === false) {
    jsonError('Invalid token', 403);
}
$userId = (int) ($auth['sub'] ?? 0);
if (!is_super_admin($userId)) {
    jsonError('Forbidden', 403);
}

$type   = $_GET['type'] ?? '';
$format = strtolower($_GET['format'] ?? 'json');

switch ($type) {
    case 'staff':
        $rows  = fetchStaff();
        $result = [];
        foreach ($rows as $row) {
            unset($row['companyId'], $row['pos'], $row['tasks']);
            $result[] = $row;
        }
        unset($rows, $row);
        $data = $result;
        unset($result);
        break;
    case 'users':
        $data = fetchUsers();
        break;
    case 'stores':
        $data = fetchStores();
        break;
    default:
        jsonError('Invalid type', 400);
}

if ($format === 'csv') {
    header('Content-Type: text/csv');
    header('Content-Disposition: attachment; filename=' . $type . '.csv');
    $out = fopen('php://output', 'w');
    if (!empty($data)) {
        fputcsv($out, array_keys($data[0]));
        foreach ($data as $row) {
            fputcsv($out, $row);
        }
    }
    fclose($out);
    exit;
}

header('Content-Type: application/json');
echo json_encode($data);
