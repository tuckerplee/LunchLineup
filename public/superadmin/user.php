<?php
require_once __DIR__ . '/../../src/data.php';
$token  = $_COOKIE['token'] ?? '';
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}
$userId = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
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
                <li class="breadcrumb-item active" aria-current="page">Users</li>
            </ol>
        </nav>
        <h1>Select Company</h1>
        <ul class="list-group">
            <?php foreach ($companies as $company) : ?>
            <li class="list-group-item d-flex justify-content-between align-items-center">
                <span><?php echo htmlspecialchars($company['name']); ?></span>
                <button type="button" class="btn btn-primary btn-sm manage-btn" data-id="<?php echo (int) $company['id']; ?>" data-name="<?php echo htmlspecialchars($company['name'], ENT_QUOTES); ?>">Manage Users</button>
            </li>
            <?php endforeach; ?>
        </ul>
        <script>
        document.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = `user.php?company_id=${btn.dataset.id}`;
                const title = `Users - ${btn.dataset.name}`;
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
$companies   = fetchCompanies();
$companyName = '';
foreach ($companies as $c) {
    if ((int) $c['id'] === $companyId) {
        $companyName = $c['name'];
        break;
    }
}
$editId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
$csrf = generate_csrf_token();
$action = $_GET['action'] ?? '';
if ($editId === 0 && $action !== 'new') {
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>Users</title>
        <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    </head>
    <body class="p-4">
        <nav aria-label="breadcrumb" class="mb-3">
            <ol class="breadcrumb">
                <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="user.php" data-title="Users">Users</a></li>
                <li class="breadcrumb-item active" aria-current="page"><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></li>
            </ol>
        </nav>
        <h1>Users and Staff</h1>
        <div class="mb-3">
            <button class="btn btn-primary me-2" id="addUser">Add User</button>
            <button class="btn btn-primary me-2" id="addStaff">Add Staff</button>
            <button class="btn btn-link" data-action="cancel">Back</button>
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
                <thead><tr><th>ID</th><th>Username</th><th>Home Store</th><th>Admin</th><th></th></tr></thead>
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
        <script src="../assets/js/modules/superadmin-nav.js"></script>
        <script src="../assets/js/modules/superadmin-staff.js"></script>
        <script>
        window.COMPANY_ID = <?php echo $companyId; ?>;
        (function () {
            const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
            const COMPANY_ID = window.COMPANY_ID;
            let userPage = 1;
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
                            tr.innerHTML = `<td>${u.id}</td><td>${u.username}</td><td>${u.homeStoreId}</td><td>${adminFlag}</td>`;
                            const td = document.createElement('td');
                            const edit = document.createElement('button');
                            edit.textContent = 'Edit';
                            edit.className = 'btn btn-sm btn-secondary me-2';
                            edit.addEventListener('click', () => {
                                const url = `user.php?company_id=${COMPANY_ID}&id=${u.id}`;
                                const title = `Edit ${u.username}`;
                                if (typeof openAdminModal === 'function') {
                                    openAdminModal(url, title);
                                } else {
                                    window.location.href = url;
                                }
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
            document.getElementById('userSearch').addEventListener('input', () => { userPage = 1; loadUsers(); });
            document.getElementById('userFilter').addEventListener('change', () => { userPage = 1; updateUserFilterLabel(); loadUsers(); });
            document.getElementById('prevUser').addEventListener('click', () => { if (userPage > 1) { userPage--; loadUsers(); } });
            document.getElementById('nextUser').addEventListener('click', () => { userPage++; loadUsers(); });
            document.getElementById('addUser').addEventListener('click', () => {
                const url = `user.php?company_id=${COMPANY_ID}&action=new`;
                const title = 'New User';
                if (typeof openAdminModal === 'function') {
                    openAdminModal(url, title);
                } else {
                    window.location.href = url;
                }
            });
            document.getElementById('addStaff').addEventListener('click', () => {
                const url = `staff.php?company_id=${COMPANY_ID}`;
                const title = 'Add Staff';
                if (typeof openAdminModal === 'function') {
                    openAdminModal(url, title);
                } else {
                    window.location.href = url;
                }
            });
            updateUserFilterLabel();
            loadUsers();
            SuperAdminStaff.initStaffTable(TOKEN, COMPANY_ID);
        })();
        </script>
    </body>
    </html>
    <?php
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title><?php echo $editId ? 'Edit' : 'New'; ?> User</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="user.php" data-title="Users">Users</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="user.php?company_id=<?php echo $companyId; ?>" data-title="Users - <?php echo htmlspecialchars($companyName, ENT_QUOTES); ?>"><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></a></li>
            <li class="breadcrumb-item active" aria-current="page"><?php echo $editId ? 'Edit User' : 'New User'; ?></li>
        </ol>
    </nav>
    <h1><?php echo $editId ? 'Edit' : 'New'; ?> User</h1>
    <form id="userForm" class="mb-5">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <input type="hidden" id="userId" value="<?php echo $editId; ?>" />
        <div class="mb-3">
            <label class="form-label">Company
                <select id="companySelect" class="form-select" required></select>
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Username
                <input type="text" id="username" class="form-control" required pattern="[A-Za-z0-9._-]{3,64}" maxlength="64" autocomplete="username" />
            </label>
            <div class="form-text">3-64 characters: letters, numbers, dot, underscore, or hyphen.</div>
        </div>
        <div class="mb-3">
            <label class="form-label">Name
                <input type="text" id="name" class="form-control" />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Password
                <input type="password" id="password" class="form-control" />
            </label>
            <div class="form-text">Leave blank to keep existing password.</div>
        </div>
        <div class="mb-3">
            <label class="form-label">Home Store
                <select id="homeStore" class="form-select" required></select>
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Assigned Stores
                <select id="assignedStores" class="form-select" multiple></select>
            </label>
            <div class="form-text">Select additional stores this user can manage.</div>
        </div>
        <div class="mb-3">
            <label class="form-label">Roles
                <select id="roles" class="form-select" multiple></select>
            </label>
            <div class="form-text">Select roles for assigned stores.</div>
        </div>
        <div class="form-check mb-3">
            <input class="form-check-input" type="checkbox" id="isAdmin" />
            <label class="form-check-label" for="isAdmin">Administrator</label>
        </div>
        <div class="mb-3">
            <label class="form-label">Locked Until
                <input type="datetime-local" id="lockedUntil" class="form-control" />
            </label>
            <div class="form-text">Leave blank to unlock.</div>
        </div>
        <button type="button" id="sendReset" class="btn btn-warning me-2">Send reset email</button>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Cancel</button>
    </form>
    <script src="../assets/js/modules/superadmin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const USER_ID = <?php echo $editId; ?>;
        const DEFAULT_COMPANY_ID = <?php echo $companyId; ?>;
        let currentCompanyId = DEFAULT_COMPANY_ID;
        function loadCompanies() {
            return fetch(`../api/companies.php?token=${encodeURIComponent(TOKEN)}`)
                .then(r => r.json())
                .then(companies => {
                    const select = document.getElementById('companySelect');
                    select.replaceChildren();
                    companies.forEach(c => {
                        const opt = document.createElement('option');
                        opt.value = c.id;
                        opt.textContent = c.name;
                        select.appendChild(opt);
                    });
                    select.value = DEFAULT_COMPANY_ID;
                });
        }
        function loadStores(companyId) {
            return fetch(`../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${companyId}`)
                .then(r => r.json())
                .then(stores => {
                    const homeSelect = document.getElementById('homeStore');
                    const storeSelect = document.getElementById('assignedStores');
                    homeSelect.replaceChildren();
                    storeSelect.replaceChildren();
                    stores.forEach(s => {
                        const opt1 = document.createElement('option');
                        opt1.value = s.id;
                        opt1.textContent = s.name;
                        homeSelect.appendChild(opt1);
                        const opt2 = document.createElement('option');
                        opt2.value = s.id;
                        opt2.textContent = s.name;
                        storeSelect.appendChild(opt2);
                    });
                    return stores;
                });
        }
        function loadRoles(companyId) {
            return fetch(`../admin-api/roles.php?token=${encodeURIComponent(TOKEN)}&company_id=${companyId}`)
                .then(r => r.json())
                .then(roles => {
                    const roleSelect = document.getElementById('roles');
                    roleSelect.replaceChildren();
                    roles.forEach(role => {
                        if (["store", "super_admin", "company_admin"].includes(role.name)) {
                            return;
                        }
                        const opt = document.createElement('option');
                        opt.value = role.name;
                        opt.textContent = role.name;
                        roleSelect.appendChild(opt);
                    });
                    return roles;
                });
        }
        function loadUser() {
            if (!USER_ID) {
                return Promise.resolve();
            }
            return fetch(`../api/users.php?token=${encodeURIComponent(TOKEN)}&company_id=${DEFAULT_COMPANY_ID}`)
                .then(r => r.json())
                .then(users => {
                    const u = users.find(x => x.id == USER_ID);
                    if (u) {
                        document.getElementById('username').value = u.username;
                        document.getElementById('name').value = u.name;
                        document.getElementById('homeStore').value = u.homeStoreId;
                        document.getElementById('isAdmin').checked = !!u.isAdmin;
                        if (u.lockedUntil) {
                            document.getElementById('lockedUntil').value = u.lockedUntil.replace(' ', 'T').slice(0, 16);
                        }
                        const storeSelect = document.getElementById('assignedStores');
                        if (u.storeIds) {
                            u.storeIds.forEach(id => {
                                const opt = Array.from(storeSelect.options).find(o => o.value == id);
                                if (opt) {
                                    opt.selected = true;
                                }
                            });
                        }
                        const roleSelect = document.getElementById('roles');
                        if (u.roles) {
                            u.roles.forEach(r => {
                                const opt = Array.from(roleSelect.options).find(o => o.value === r);
                                if (opt) {
                                    opt.selected = true;
                                }
                            });
                        }
                    }
                });
        }
        function refreshCompany() {
            currentCompanyId = parseInt(document.getElementById('companySelect').value, 10);
            window.COMPANY_ID = currentCompanyId;
            loadStores(currentCompanyId).then(() => loadRoles(currentCompanyId));
        }
        loadCompanies().then(() => {
            loadStores(DEFAULT_COMPANY_ID)
                .then(() => loadRoles(DEFAULT_COMPANY_ID))
                .then(() => loadUser());
        });
        document.getElementById('companySelect').addEventListener('change', refreshCompany);
        document.getElementById('userForm').addEventListener('submit', e => {
            e.preventDefault();
            const homeStore = document.getElementById('homeStore').value;
            const storeSelect = document.getElementById('assignedStores');
            const storeIds = Array.from(storeSelect.selectedOptions).map(opt => parseInt(opt.value, 10));
            if (!homeStore) {
                alert('Please select a home store.');
                return;
            }
            const payload = {
                id: USER_ID || undefined,
                username: document.getElementById('username').value,
                name: document.getElementById('name').value,
                homeStoreId: parseInt(homeStore, 10),
                isAdmin: document.getElementById('isAdmin').checked ? 1 : 0,
                lockedUntil: document.getElementById('lockedUntil').value
                    ? document.getElementById('lockedUntil').value.replace('T', ' ') + ':00'
                    : null
            };
            if (storeIds.length > 0) {
                payload.storeIds = storeIds;
            }
            const roleSelect = document.getElementById('roles');
            const roles = Array.from(roleSelect.selectedOptions).map(opt => opt.value);
            if (roles.length > 0) {
                payload.roles = roles;
            }
            const pwd = document.getElementById('password').value;
            if (pwd) {
                payload.password = pwd;
            }
            fetch(`../api/users.php?token=${encodeURIComponent(TOKEN)}&company_id=${currentCompanyId}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload)
            }).then(() => {
                adminGoBack('user_saved');
            });
        });
        document.getElementById('sendReset').addEventListener('click', () => {
            const username = document.getElementById('username').value;
            fetch('../api/reset_request.php', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ username })
            }).then(() => alert('Reset email sent'));
        });
    })();
    </script>
</body>
</html>
