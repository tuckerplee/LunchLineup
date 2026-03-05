<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
$userId = (int) ($auth['sub'] ?? 0);
if ($companyId === 0 || $auth === false || (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin']))) {
    header('Location: ../index.php');
    exit;
}
set_audit_user($userId);
set_audit_company($companyId);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Reporting</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <h1>Reporting</h1>
    <p>Reporting tools are not available.</p>
    <script src="../assets/js/modules/admin-nav.js"></script>
</body>
</html>
