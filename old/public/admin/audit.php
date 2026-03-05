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
    <h1>Audit Logs</h1>
    <form id="filterForm" class="row g-3 mb-3">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="col">
            <input type="text" id="userId" class="form-control" placeholder="User ID" />
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
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script>
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const COMPANY_ID = <?php echo $companyId; ?>;
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
            fetch(`../admin-api/audit.php?${params.toString()}`)
                .then(r => r.json())
                .then(data => {
                    const tbody = document.getElementById('logTable');
                    tbody.replaceChildren();
                    data.forEach(log => {
                        const tr = document.createElement('tr');
                        const email = log.email || '';
                        const company = log.company || '';
                        const store = log.store || '';
                        tr.innerHTML = `<td>${log.id}</td><td>${email}</td><td>${log.action}</td>` +
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
