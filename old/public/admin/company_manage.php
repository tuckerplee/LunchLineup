<?php
require_once __DIR__ . '/../../src/data.php';
$token     = $_COOKIE['token'] ?? '';
$auth      = verify_api_token($token);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if (
    $auth === false
    || $companyId === 0
    || (!is_super_admin((int) ($auth['sub'] ?? 0))
        && !is_company_admin((int) ($auth['sub'] ?? 0), $companyId))
) {
    header('Location: ../index.php');
    exit;
}
$companies   = fetchCompanies();
$companyName = '';
foreach ($companies as $c) {
    if ((int) $c['id'] === $companyId) {
        $companyName = $c['name'];
        break;
    }
}
if ($companyName === '') {
    http_response_code(404);
    echo 'Company not found';
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Manage Company</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item active" aria-current="page">Manage Company</li>
        </ol>
    </nav>
    <h1>Manage Company - <?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></h1>
    <?php if (isset($_GET['status'])) : ?>
        <?php
        $msg = $_GET['status'] === 'saved'
            ? 'Store saved.'
            : ($_GET['status'] === 'user_saved'
                ? 'User saved.'
                : ($_GET['status'] === 'staff_saved' ? 'Staff saved.' : ''));
        if ($msg !== '') :
        ?>
        <div class="alert alert-success">
            <?php echo $msg; ?>
        </div>
        <?php endif; ?>
    <?php endif; ?>
    <div class="mb-3">
        <button class="btn btn-primary me-2" id="addStore">Manage Stores</button>
        <button class="btn btn-primary me-2" id="addUser">Add User</button>
        <button class="btn btn-primary" id="addStaff">Add Staff</button>
    </div>
    <div class="mb-4">
        <h2>Stores</h2>
        <div class="d-flex mb-2">
            <input type="text" id="storeSearch" class="form-control me-2" placeholder="Search stores" />
            <button class="btn btn-outline-secondary me-2" id="prevStore">Prev</button>
            <button class="btn btn-outline-secondary" id="nextStore">Next</button>
        </div>
        <table class="table" id="storeTable">
            <thead><tr><th>ID</th><th>Name</th><th>Location</th><th></th></tr></thead>
            <tbody></tbody>
        </table>
    </div>
    <div class="mb-4">
        <h2>Users <span id="userFilterLabel" class="text-muted">(Non-admins)</span></h2>
        <div class="d-flex mb-2">
            <input type="text" id="userSearch" class="form-control me-2" placeholder="Search users" />
            <select id="userFilter" class="form-select w-auto me-2">
                <option value="false" selected>Non-admins</option>
                <option value="true">Admins</option>
            </select>
            <button class="btn btn-outline-secondary me-2" id="prevUser">Prev</button>
            <button class="btn btn-outline-secondary" id="nextUser">Next</button>
        </div>
        <table class="table" id="userTable">
            <thead><tr><th>ID</th><th>Email</th><th>Home Store</th><th>Admin</th><th></th></tr></thead>
            <tbody></tbody>
        </table>
    </div>
    <div class="mb-4">
        <h2>Staff</h2>
        <div class="d-flex mb-2">
            <input type="text" id="staffSearch" class="form-control me-2" placeholder="Search staff" />
            <button class="btn btn-outline-secondary me-2" id="prevStaff">Prev</button>
            <button class="btn btn-outline-secondary" id="nextStaff">Next</button>
        </div>
        <table class="table" id="staffTable">
            <thead><tr><th>ID</th><th>Name</th><th>Store</th><th></th></tr></thead>
            <tbody></tbody>
        </table>
    </div>
    <button type="button" class="btn btn-link" id="backBtn">Back</button>
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script src="../assets/js/modules/admin-staff.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        let storePage = 1;
        let userPage = 1;
        function loadStores() {
            const params = new URLSearchParams({ token: TOKEN, company_id: COMPANY_ID, page: storePage });
            const search = document.getElementById('storeSearch').value.trim();
            if (search !== '') params.append('search', search);
            fetch(`../api/stores.php?${params.toString()}`)
                .then(r => r.json())
                .then(data => {
                    const tbody = document.querySelector('#storeTable tbody');
                    tbody.replaceChildren();
                    data.forEach(s => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = `<td>${s.id}</td><td>${s.name}</td><td>${s.location || ''}</td>`;
                        const td = document.createElement('td');
                        const edit = document.createElement('button');
                        edit.textContent = 'Edit';
                        edit.className = 'btn btn-sm btn-secondary me-2';
                        edit.addEventListener('click', () => {
                            openAdminModal(`store.php?company_id=${COMPANY_ID}&id=${s.id}`, 'Edit Store');
                        });
                        const del = document.createElement('button');
                        del.textContent = 'Delete';
                        del.className = 'btn btn-sm btn-danger';
                        del.addEventListener('click', () => {
                            if (!confirm('Delete store?')) return;
                            fetch(`../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}&id=${s.id}`, { method: 'DELETE' })
                                .then(() => loadStores());
                        });
                        td.appendChild(edit);
                        td.appendChild(del);
                        tr.appendChild(td);
                        tbody.appendChild(tr);
                    });
                });
        }
        function updateUserFilterLabel() {
            const val = document.getElementById('userFilter').value;
            const text = val === 'true' ? 'Admins' : 'Non-admins';
            document.getElementById('userFilterLabel').textContent = `(${text})`;
        }
        function loadUsers() {
            const admins = document.getElementById('userFilter').value;
            const params = new URLSearchParams({ token: TOKEN, company_id: COMPANY_ID, page: userPage, admins });
            const search = document.getElementById('userSearch').value.trim();
            if (search !== '') params.append('search', search);
            fetch(`../api/users.php?${params.toString()}`)
                .then(r => r.json())
                .then(data => {
                    const tbody = document.querySelector('#userTable tbody');
                    tbody.replaceChildren();
                    data.forEach(u => {
                        const tr = document.createElement('tr');
                        const adminFlag = u.isAdmin ? 'Yes' : 'No';
                        tr.innerHTML = `<td>${u.id}</td><td>${u.email}</td><td>${u.homeStoreId}</td><td>${adminFlag}</td>`;
                        const td = document.createElement('td');
                        const edit = document.createElement('button');
                        edit.textContent = 'Edit';
                        edit.className = 'btn btn-sm btn-secondary me-2';
                        edit.addEventListener('click', () => {
                            openAdminModal(`user.php?company_id=${COMPANY_ID}&id=${u.id}`, 'Edit User');
                        });
                        const del = document.createElement('button');
                        del.textContent = 'Delete';
                        del.className = 'btn btn-sm btn-danger';
                        del.addEventListener('click', () => {
                            if (!confirm('Delete user?')) return;
                            fetch(`../api/users.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}&id=${u.id}`, { method: 'DELETE' })
                                .then(() => loadUsers());
                        });
                        td.appendChild(edit);
                        td.appendChild(del);
                        tr.appendChild(td);
                        tbody.appendChild(tr);
                    });
                });
        }
        document.getElementById('storeSearch').addEventListener('input', () => { storePage = 1; loadStores(); });
        document.getElementById('userSearch').addEventListener('input', () => { userPage = 1; loadUsers(); });
        document.getElementById('userFilter').addEventListener('change', () => {
            userPage = 1;
            updateUserFilterLabel();
            loadUsers();
        });
        document.getElementById('prevStore').addEventListener('click', () => { if (storePage > 1) { storePage--; loadStores(); } });
        document.getElementById('nextStore').addEventListener('click', () => { storePage++; loadStores(); });
        document.getElementById('prevUser').addEventListener('click', () => { if (userPage > 1) { userPage--; loadUsers(); } });
        document.getElementById('nextUser').addEventListener('click', () => { userPage++; loadUsers(); });
        document.getElementById('addStore').addEventListener('click', () => {
            openAdminModal(`store.php?company_id=${COMPANY_ID}`, 'Manage Stores');
        });
        document.getElementById('addUser').addEventListener('click', () => {
            openAdminModal(`user.php?company_id=${COMPANY_ID}&action=new`, 'New User');
        });
        document.getElementById('addStaff').addEventListener('click', () => {
            openAdminModal(`staff.php?company_id=${COMPANY_ID}`, 'Add Staff');
        });
        document.getElementById('backBtn').addEventListener('click', () => {
            adminGoBack();
        });
        loadStores();
        updateUserFilterLabel();
        loadUsers();
        AdminStaff.initStaffTable(TOKEN, COMPANY_ID);
    })();
    </script>
</body>
</html>
