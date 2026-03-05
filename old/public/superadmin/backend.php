<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Back End</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item active" aria-current="page">Back End</li>
        </ol>
    </nav>
    <h1>Back End</h1>
    <p class="mb-3">
        Run database upgrades with the coordinator. This replaces the old schema rebuild endpoint.
    </p>
    <div class="card">
        <div class="card-body">
            <h2 class="h5">Upgrade options</h2>
            <ul class="mb-0">
                <li><a href="../update.php" target="_blank" rel="noopener">Open the upgrade coordinator</a> and sign in with
                    your super-admin username.</li>
                <li>From the server command line, execute <code>php scripts/upgrade.php</code>.</li>
            </ul>
        </div>
    </div>
</body>
</html>
