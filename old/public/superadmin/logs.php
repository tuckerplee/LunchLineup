<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
$userFilterId = isset($_GET['user_id']) ? (int) $_GET['user_id'] : 0;
if ($companyId === 0) {
    $companies = fetchCompanies();
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>Select Company</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    </head>
    <body class="p-4">
        <nav aria-label="breadcrumb" class="mb-3">
            <ol class="breadcrumb">
                <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
                <li class="breadcrumb-item active" aria-current="page">Logs</li>
            </ol>
        </nav>
        <h1>Select Company</h1>
        <ul class="list-group">
            <?php foreach ($companies as $company) : ?>
            <li class="list-group-item d-flex justify-content-between align-items-center">
                <span><?php echo htmlspecialchars($company['name']); ?></span>
                <button type="button" class="btn btn-primary btn-sm manage-btn" data-id="<?php echo (int) $company['id']; ?>" data-name="<?php echo htmlspecialchars($company['name'], ENT_QUOTES); ?>">View Logs</button>
            </li>
            <?php endforeach; ?>
        </ul>
        <script>
        document.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = `logs.php?company_id=${btn.dataset.id}`;
                const title = `Logs - ${btn.dataset.name}`;
                if (typeof openAdminModal === 'function') {
                    openAdminModal(url, title);
                } else {
                    window.location.href = url;
                }
            });
        });
        </script>
    </body>
    </html>
    <?php
    exit;
}
set_audit_user((int) ($auth['sub'] ?? 0));
set_audit_company($companyId);
$companies   = fetchCompanies();
$companyName = '';
foreach ($companies as $c) {
    if ((int) $c['id'] === $companyId) {
        $companyName = $c['name'];
        break;
    }
}
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Audit Logs</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="logs.php" data-title="Logs">Logs</a></li>
            <li class="breadcrumb-item active" aria-current="page"><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></li>
        </ol>
    </nav>
    <h1>Audit Logs</h1>
    <form id="filterForm" class="row g-3 mb-3">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="col">
            <input type="text" id="userId" class="form-control" placeholder="User ID" value="<?php echo $userFilterId ?: ''; ?>" />
        </div>
        <div class="col">
            <input type="text" id="action" class="form-control" placeholder="Action" />
        </div>
        <div class="col">
            <select id="perPage" class="form-select">
                <option value="10">10</option>
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100" selected>100</option>
            </select>
        </div>
        <div class="col">
            <button type="submit" class="btn btn-primary">Filter</button>
        </div>
    </form>
    <table class="table">
        <thead>
            <tr><th>ID</th><th>User</th><th>Action</th><th>Company</th><th>Store</th><th>Time</th></tr>
        </thead>
        <tbody id="logTable"></tbody>
    </table>
    <div class="d-flex justify-content-between">
        <button class="btn btn-secondary" id="prevPage">Prev</button>
        <button class="btn btn-secondary" id="nextPage">Next</button>
    </div>
    <script src="../assets/js/modules/superadmin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        let currentPage = 1;
        function loadLogs() {
            const params = new URLSearchParams({
                token: TOKEN,
                company_id: COMPANY_ID,
                page: currentPage,
                per_page: document.getElementById('perPage').value
            });
            const userId = document.getElementById('userId').value.trim();
            const action = document.getElementById('action').value.trim();
            if (userId !== '') params.append('user_id', userId);
            if (action !== '') params.append('action', action);
            fetch(`../superadmin-api/logs.php?${params.toString()}`)
                .then(r => r.json())
                .then(data => {
                    const tbody = document.getElementById('logTable');
                    tbody.replaceChildren();
                    data.forEach(log => {
                        const tr = document.createElement('tr');
                        const username = log.username || '';
                        const company = log.company || '';
                        const store = log.store || '';
                        tr.innerHTML = `<td>${log.id}</td><td>${username}</td><td>${log.action}</td>` +
                            `<td>${company}</td><td>${store}</td><td>${log.created_at}</td>`;
                        tbody.appendChild(tr);
                    });
                });
        }
        document.getElementById('filterForm').addEventListener('submit', e => {
            e.preventDefault();
            currentPage = 1;
            loadLogs();
        });
        document.getElementById('prevPage').addEventListener('click', () => {
            if (currentPage > 1) {
                currentPage--;
                loadLogs();
            }
        });
        document.getElementById('nextPage').addEventListener('click', () => {
            currentPage++;
            loadLogs();
        });
        document.getElementById('perPage').addEventListener('change', () => {
            currentPage = 1;
            loadLogs();
        });
        loadLogs();
    })();
    </script>
</body>
</html>
