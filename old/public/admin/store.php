<?php
require_once __DIR__ . '/../../src/data.php';
$token     = $_COOKIE['token'] ?? '';
$auth      = verify_api_token($token);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
$userId    = (int) ($auth['sub'] ?? 0);
if (
    $auth === false
    || $companyId === 0
    || (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin']))
) {
    if ($companyId === 0) {
        http_response_code(400);
        echo 'Missing company_id';
    } else {
        header('Location: ../index.php');
    }
    exit;
}
$storeId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title><?php echo $storeId ? 'Edit' : 'New'; ?> Store</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <h1><?php echo $storeId ? 'Edit' : 'New'; ?> Store</h1>
    <form id="storeForm" class="mb-5">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <input type="hidden" id="storeId" value="<?php echo $storeId; ?>" />
        <div class="mb-3">
            <label class="form-label">Name
                <input type="text" id="name" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Location
                <input type="text" id="location" class="form-control" />
            </label>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Cancel</button>
    </form>
    <h2>Invite User</h2>
    <form id="inviteForm">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="mb-3">
            <label class="form-label">Email
                <input type="email" id="email" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Role
                <select id="role" class="form-select">
                    <option value="store">Store</option>
                    <option value="viewer">Viewer</option>
                </select>
            </label>
        </div>
        <button type="submit" class="btn btn-secondary">Send Invite</button>
    </form>
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const STORE_ID = <?php echo $storeId; ?>;
        if (STORE_ID) {
            fetch(`../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`)
                .then((r) => r.json())
                .then((data) => {
                    const store = data.find((s) => s.id == STORE_ID);
                    if (store) {
                        document.getElementById('name').value = store.name;
                        document.getElementById('location').value = store.location || '';
                    }
                });
        }
        document.getElementById('storeForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const payload = {
                id: STORE_ID || undefined,
                name: document.getElementById('name').value,
                location: document.getElementById('location').value,
            };
            fetch(`../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
                .then((r) => r.json())
                .then(() => {
                    adminGoBack('saved');
                });
        });
        document.getElementById('inviteForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const payload = {
                email: document.getElementById('email').value,
                storeId: STORE_ID,
                role: document.getElementById('role').value,
            };
            fetch(`../api/invitations.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            })
                .then((r) => r.json())
                .then(() => alert('Invitation sent.'));
        });
    })();
    </script>
</body>
</html>
