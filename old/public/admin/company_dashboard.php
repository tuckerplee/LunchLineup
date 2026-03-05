<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/config.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    http_response_code(400);
    echo 'Missing company_id';
    exit;
}
if ($auth === false || (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin']))) {
    header('Location: ../index.php');
    exit;
}
session_start();
$db = getDb();
if (!isset($_SESSION['avatar'])) {
    $_SESSION['avatar'] = 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/user-circle.svg';
}
$avatar = $_SESSION['avatar'];
if (!isset($_SESSION['name'])) {
    $stmt = $db->prepare('SELECT name FROM staff WHERE id = ?');
    $stmt->execute([$userId]);
    $n = $stmt->fetchColumn();
    $_SESSION['name'] = $n !== false ? decryptField($n) : 'Profile';
}
$name = $_SESSION['name'];
$stores = fetchStores($companyId);
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>LunchLineup — Company Dashboard</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    <link rel="stylesheet" href="../assets/css/nav.css" />
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    <script src="https://cdn.jsdelivr.net/npm/chart.js"></script>
    <script src="../assets/js/modules/utils.js"></script>
</head>
<body class="gradient-bg">
    <nav class="navbar navbar-dark bg-dark">
        <div class="container-fluid">
            <a class="navbar-brand d-flex align-items-center gap-2" href="#">
                <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" alt="" class="brand-icon" />
                LunchLineup
            </a>
            <a class="top-nav-btn ms-auto me-2" href="../app.php" data-bs-toggle="tooltip" title="Return to LunchLineup">Return to LunchLineup</a>
            <a class="top-nav-btn me-2" href="../assets/templates/README.md" target="_blank" data-bs-toggle="tooltip" title="View help docs">Help</a>
            <div class="dropdown ms-2">
                <a href="#" class="d-flex align-items-center text-white text-decoration-none dropdown-toggle" id="userDropdown" data-bs-toggle="dropdown" aria-expanded="false">
                    <img src="<?php echo htmlspecialchars($avatar, ENT_QUOTES); ?>" alt="Avatar" class="avatar">
                    <span class="ms-2 d-none d-sm-inline"><?php echo htmlspecialchars($name, ENT_QUOTES); ?></span>
                </a>
                <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="userDropdown">
                    <li><a class="dropdown-item" href="#">Profile</a></li>
                    <li><hr class="dropdown-divider"></li>
                    <li><a class="dropdown-item" href="../logout.php">Logout</a></li>
                </ul>
            </div>
        </div>
    </nav>
    <div class="container py-4">
        <h1 class="text-center mb-4">Company Admin Portal</h1>
        <?php if (isset($_GET['status'])) : ?>
            <div class="alert alert-success">
                <?php
                echo match ($_GET['status']) {
                    'saved' => 'Store saved.',
                    'user_saved' => 'User saved.',
                    default => ''
                };
                ?>
            </div>
        <?php endif; ?>

        <div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 g-4 mb-4">
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-path.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Automation Settings" />
                            Automation Settings
                        </h5>
                        <p class="card-text">Configure automation rules.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=automation.php&title=Automation+Settings" data-title="Automation Settings">Open</button>
                    </div>
                </div>
            </div>
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-check.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Chore Control" />
                            Chore Control
                        </h5>
                        <p class="card-text">Manage chore templates and priorities.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=chore_control.php&title=Chore+Control" data-title="Chore Control">Open</button>
                    </div>
                </div>
            </div>
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/building-storefront.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Manage Stores" />
                            Manage Stores
                        </h5>
                        <p class="card-text">Create a new store.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=store.php&title=Store" data-title="Manage Stores">Open</button>
                    </div>
                </div>
            </div>
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/user-plus.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Manage Users" />
                            Manage Users
                        </h5>
                        <p class="card-text">Create a new user.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="company_manage.php?company_id=<?php echo $companyId; ?>" data-title="Manage Users">Open</button>
                    </div>
                </div>
            </div>
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/cog-6-tooth.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Settings" />
                            Settings
                        </h5>
                        <p class="card-text">Configure application settings.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=settings.php&title=Settings" data-title="Settings">Open</button>
                    </div>
                </div>
            </div>
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/chart-bar-square.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Reporting" />
                            Reporting
                        </h5>
                        <p class="card-text">Run reports for this company.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=reporting.php&title=Reporting" data-title="Reporting">Open</button>
                    </div>
                </div>
            </div>
            <div class="col">
                <div class="card bg-light h-100 action-card dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-list.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Audit/Logging" />
                            Audit/Logging
                        </h5>
                        <p class="card-text">View activity logs.</p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=audit.php&title=Audit+Logs" data-title="Audit Logs">Open</button>
                    </div>
                </div>
            </div>
        </div>

        <ul class="nav nav-tabs mb-4" id="dashboardTabs" role="tablist">
            <li class="nav-item" role="presentation">
                <button class="nav-link active" id="metrics-tab" data-bs-toggle="tab" data-bs-target="#metrics" type="button" role="tab">Metrics</button>
            </li>
            <li class="nav-item" role="presentation">
                <button class="nav-link" id="stores-tab" data-bs-toggle="tab" data-bs-target="#stores" type="button" role="tab">Stores</button>
            </li>
            <li class="nav-item" role="presentation">
                <button class="nav-link" id="users-tab" data-bs-toggle="tab" data-bs-target="#users" type="button" role="tab">Users</button>
            </li>
            <li class="nav-item" role="presentation">
                <button class="nav-link" id="import-tab" data-bs-toggle="tab" data-bs-target="#import" type="button" role="tab">Import/Export</button>
            </li>
        </ul>

        <div class="tab-content">
            <div class="tab-pane fade show active" id="metrics" role="tabpanel" aria-labelledby="metrics-tab">
                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">Metrics</h5>
                        <div class="d-flex align-items-center mb-3">
                            <label for="timeframe" class="me-2">Timeframe</label>
                            <select id="timeframe" class="form-select w-auto">
                                <option value="week">Week</option>
                                <option value="month">Month</option>
                            </select>
                        </div>
                        <canvas id="metricsChart" height="100"></canvas>
                        <p class="mt-2">Pending chores: <span id="pendingChores">0</span></p>
                    </div>
                </div>
            </div>
            <div class="tab-pane fade" id="stores" role="tabpanel" aria-labelledby="stores-tab">
                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">Stores</h5>
                        <div class="d-flex mb-3">
                            <input type="text" id="storeSearch" class="form-control me-2" placeholder="Search stores" />
                            <button class="btn btn-outline-secondary me-2" id="prevStore">Prev</button>
                            <button class="btn btn-outline-secondary" id="nextStore">Next</button>
                        </div>
                        <div class="table-responsive">
                            <table class="table" id="storeTable">
                                <thead>
                                    <tr><th>ID</th><th>Name</th><th>Location</th><th></th></tr>
                                </thead>
                                <tbody></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
            <div class="tab-pane fade" id="users" role="tabpanel" aria-labelledby="users-tab">
                <div class="card mb-4">
                    <div class="card-body">
                        <h5 class="card-title">Users</h5>
                        <div class="d-flex mb-3">
                            <input type="text" id="userSearch" class="form-control me-2" placeholder="Search users" />
                            <button class="btn btn-outline-secondary me-2" id="prevUser">Prev</button>
                            <button class="btn btn-outline-secondary" id="nextUser">Next</button>
                        </div>
                        <div class="table-responsive">
                            <table class="table" id="userTable">
                                <thead>
                                    <tr><th>ID</th><th>Email</th><th>Home Store</th><th>Admin</th><th></th></tr>
                                </thead>
                                <tbody></tbody>
                            </table>
                        </div>
                    </div>
                </div>
            </div>
            <div class="tab-pane fade" id="import" role="tabpanel" aria-labelledby="import-tab">
                <div class="row g-3">
                    <div class="col-md-4">
                        <div class="card h-100">
                            <div class="card-body">
                                <h5 class="card-title">Stores</h5>
                                <form class="mb-2" action="../admin-api/bulk_import.php?type=stores&amp;token=<?php echo urlencode($token); ?>" method="post" enctype="multipart/form-data">
                                    <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
                                    <input type="file" name="file" class="form-control mb-2" accept=".csv,.json" required />
                                    <button class="btn btn-primary w-100">Import Stores</button>
                                </form>
                                <div class="d-grid gap-2 d-md-block">
                                    <a class="btn btn-outline-secondary me-2" href="../admin-api/bulk_export.php?type=stores&amp;format=json&amp;token=<?php echo urlencode($token); ?>">Export JSON</a>
                                    <a class="btn btn-outline-secondary" href="../admin-api/bulk_export.php?type=stores&amp;format=csv&amp;token=<?php echo urlencode($token); ?>">Export CSV</a>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card h-100">
                            <div class="card-body">
                                <h5 class="card-title">Users</h5>
                                <form class="mb-2" action="../admin-api/bulk_import.php?type=users&amp;token=<?php echo urlencode($token); ?>" method="post" enctype="multipart/form-data">
                                    <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
                                    <input type="file" name="file" class="form-control mb-2" accept=".csv,.json" required />
                                    <button class="btn btn-primary w-100">Import Users</button>
                                </form>
                                <div class="d-grid gap-2 d-md-block">
                                    <a class="btn btn-outline-secondary me-2" href="../admin-api/bulk_export.php?type=users&amp;format=json&amp;token=<?php echo urlencode($token); ?>">Export JSON</a>
                                    <a class="btn btn-outline-secondary" href="../admin-api/bulk_export.php?type=users&amp;format=csv&amp;token=<?php echo urlencode($token); ?>">Export CSV</a>
                                </div>
                            </div>
                        </div>
                    </div>
                    <div class="col-md-4">
                        <div class="card h-100">
                            <div class="card-body">
                                <h5 class="card-title">Staff</h5>
                                <form class="mb-2" action="../admin-api/bulk_import.php?type=staff&amp;token=<?php echo urlencode($token); ?>" method="post" enctype="multipart/form-data">
                                    <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
                                    <input type="file" name="file" class="form-control mb-2" accept=".csv,.json" required />
                                    <button class="btn btn-primary w-100">Import Staff</button>
                                </form>
                                <div class="d-grid gap-2 d-md-block">
                                    <a class="btn btn-outline-secondary me-2" href="../admin-api/bulk_export.php?type=staff&amp;format=json&amp;token=<?php echo urlencode($token); ?>">Export JSON</a>
                                    <a class="btn btn-outline-secondary" href="../admin-api/bulk_export.php?type=staff&amp;format=csv&amp;token=<?php echo urlencode($token); ?>">Export CSV</a>
                                </div>
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="actionModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-lg">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="actionModalLabel"></h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body" id="actionBody"></div>
            </div>
        </div>
    </div>

    <div class="modal fade" id="confirmModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title">Confirm Delete</h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body">
                    Are you sure you want to delete this <span id="confirmItemType"></span>?
                </div>
                <div class="modal-footer">
                    <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                    <button type="button" class="btn btn-danger" id="confirmDeleteBtn">Delete</button>
                </div>
            </div>
        </div>
    </div>

    <script type="module">
        import { initDashboard } from "../assets/js/dashboard.js";
        initDashboard({
            token: "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>",
            companyId: <?php echo $companyId; ?>,
            storePageSize: <?php echo DEFAULT_PAGE_SIZE; ?>,
            userPageSize: <?php echo DEFAULT_PAGE_SIZE; ?>
        });
    </script>
</body>
</html>
