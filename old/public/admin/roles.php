<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false) {
    header('Location: ../index.php');
    exit;
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    http_response_code(400);
    echo 'Missing company_id';
    exit;
}
if (!in_array($companyId, $auth['companies'] ?? [], true) && empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo 'Forbidden';
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
    <title>Roles</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <h1>Roles</h1>
    <form id="roleForm" class="mb-4">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <input type="hidden" id="roleId" />
        <div class="mb-3">
            <label class="form-label">Name
                <input type="text" id="name" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Permissions (comma separated)
                <input type="text" id="permissions" class="form-control" />
            </label>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Cancel</button>
    </form>
    <table class="table">
        <thead>
            <tr><th>ID</th><th>Name</th><th>Permissions</th><th></th></tr>
        </thead>
        <tbody id="roleTable"></tbody>
    </table>
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        let editId = 0;
        function loadRoles() {
            fetch(`../admin-api/roles.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`)
                .then((r) => r.json())
                .then((data) => {
                    const tbody = document.getElementById('roleTable');
                    tbody.replaceChildren();
                    data.forEach((role) => {
                        const tr = document.createElement('tr');
                        const perms = role.permissions ? role.permissions.join(', ') : '';
                        tr.innerHTML =
                            `<td>${role.id}</td><td>${role.name}</td><td>${perms}</td>` +
                            `<td><button class="btn btn-sm btn-secondary edit-role" data-id="${role.id}">Edit</button>` +
                            `<button class="btn btn-sm btn-danger ms-2 del-role" data-id="${role.id}">Delete</button></td>`;
                        tbody.appendChild(tr);
                    });
                    document.querySelectorAll('.edit-role').forEach((btn) => {
                        btn.addEventListener('click', () => {
                            editId = parseInt(btn.dataset.id, 10);
                            const role = data.find((r) => r.id === editId);
                            if (role) {
                                document.getElementById('roleId').value = role.id;
                                document.getElementById('name').value = role.name;
                                document.getElementById('permissions').value = role.permissions.join(',');
                            }
                        });
                    });
                    document.querySelectorAll('.del-role').forEach((btn) => {
                        btn.addEventListener('click', () => {
                            const id = btn.dataset.id;
                            fetch(`../admin-api/roles.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}&id=${id}`, {
                                method: 'DELETE',
                            }).then(() => loadRoles());
                        });
                    });
                });
        }
        document.getElementById('roleForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const payload = {
                id: editId || undefined,
                name: document.getElementById('name').value,
                permissions: document
                    .getElementById('permissions')
                    .value.split(',')
                    .map((p) => p.trim())
                    .filter(Boolean),
            };
            fetch(`../admin-api/roles.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).then(() => {
                editId = 0;
                document.getElementById('roleForm').reset();
                loadRoles();
            });
        });
        loadRoles();
    })();
    </script>
</body>
</html>
