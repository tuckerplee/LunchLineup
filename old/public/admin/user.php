<?php
require_once __DIR__ . '/../../src/data.php';
$token     = $_COOKIE['token'] ?? '';
$auth      = verify_api_token($token);
if ($auth === false) {
    header('Location: ../index.php');
    exit;
}
$userId    = (int) ($auth['sub'] ?? 0);
$isSuper   = !empty($auth['isSuperAdmin']);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if (!$isSuper) {
    if ($companyId === 0) {
        http_response_code(400);
        echo 'Missing company_id';
        exit;
    }
    if (!is_company_admin($userId, $companyId)) {
        header('Location: ../index.php');
        exit;
    }
}
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
                const url = `../admin/user.php?company_id=${btn.dataset.id}`;
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
$editId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
$csrf = generate_csrf_token();
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
    <h1><?php echo $editId ? 'Edit' : 'New'; ?> User</h1>
    <form id="userForm" class="mb-5">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <input type="hidden" id="userId" value="<?php echo $editId; ?>" />
        <div class="mb-3">
            <label class="form-label">Email
                <input type="email" id="email" class="form-control" required />
            </label>
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
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const USER_ID = <?php echo $editId; ?>;
        function loadStores() {
            return fetch(`../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`)
                .then((r) => r.json())
                .then((stores) => {
                    const homeSelect = document.getElementById("homeStore");
                    const storeSelect = document.getElementById("assignedStores");
                    stores.forEach((s) => {
                        const opt1 = document.createElement("option");
                        opt1.value = s.id;
                        opt1.textContent = s.name;
                        homeSelect.appendChild(opt1);
                        const opt2 = document.createElement("option");
                        opt2.value = s.id;
                        opt2.textContent = s.name;
                        storeSelect.appendChild(opt2);
                    });
                    return stores;
                });
        }
        function loadRoles() {
            return fetch(`../admin-api/roles.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`)
                .then((r) => r.json())
                .then((roles) => {
                    const roleSelect = document.getElementById("roles");
                    roles.forEach((role) => {
                        if (["store", "super_admin", "company_admin"].includes(role.name)) {
                            return;
                        }
                        const opt = document.createElement("option");
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
            return fetch(`../api/users.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`)
                .then((r) => r.json())
                .then((users) => {
                    const u = users.find((x) => x.id == USER_ID);
                    if (u) {
                        document.getElementById("email").value = u.email;
                        document.getElementById("name").value = u.name;
                        document.getElementById("homeStore").value = u.homeStoreId;
                        document.getElementById("isAdmin").checked = !!u.isAdmin;
                        if (u.lockedUntil) {
                            document.getElementById("lockedUntil").value = u.lockedUntil.replace(" ", "T").slice(0, 16);
                        }
                        const storeSelect = document.getElementById("assignedStores");
                        if (u.storeIds) {
                            u.storeIds.forEach((id) => {
                                const opt = Array.from(storeSelect.options).find((o) => o.value == id);
                                if (opt) {
                                    opt.selected = true;
                                }
                            });
                        }
                        const roleSelect = document.getElementById("roles");
                        if (u.roles) {
                            u.roles.forEach((r) => {
                                const opt = Array.from(roleSelect.options).find((o) => o.value === r);
                                if (opt) {
                                    opt.selected = true;
                                }
                            });
                        }
                    }
                });
        }
        loadStores()
            .then(() => loadRoles())
            .then(() => loadUser());
        document.getElementById("userForm").addEventListener("submit", (e) => {
            e.preventDefault();
            const homeStore = document.getElementById("homeStore").value;
            const storeSelect = document.getElementById("assignedStores");
            const storeIds = Array.from(storeSelect.selectedOptions).map((opt) =>
                parseInt(opt.value, 10)
            );
            if (!homeStore) {
                alert("Please select a home store.");
                return;
            }
            const payload = {
                id: USER_ID || undefined,
                email: document.getElementById("email").value,
                name: document.getElementById("name").value,
                homeStoreId: parseInt(homeStore, 10),
                isAdmin: document.getElementById("isAdmin").checked ? 1 : 0,
                lockedUntil: document.getElementById("lockedUntil").value
                    ? document.getElementById("lockedUntil").value.replace("T", " ") + ":00"
                    : null,
            };
            if (storeIds.length > 0) {
                payload.storeIds = storeIds;
            }
            const roleSelect = document.getElementById("roles");
            const roles = Array.from(roleSelect.selectedOptions).map((opt) => opt.value);
            if (roles.length > 0) {
                payload.roles = roles;
            }
            const pwd = document.getElementById("password").value;
            if (pwd) {
                payload.password = pwd;
            }
            fetch(`../api/users.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify(payload),
            }).then(() => {
                adminGoBack("user_saved");
            });
        });
        document.getElementById("sendReset").addEventListener("click", () => {
            const email = document.getElementById("email").value;
            fetch("../api/reset_request.php", {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ email }),
            }).then(() => alert("Reset email sent"));
        });
    })();
    </script>
</body>
</html>
