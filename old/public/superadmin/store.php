<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    http_response_code(400);
    echo 'Missing company_id';
    exit;
}
$storeId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
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
    <title><?php echo $storeId ? 'Edit' : 'New'; ?> Store</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="company.php" data-title="Companies">Companies</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="company_manage.php?company_id=<?php echo $companyId; ?>" data-title="Manage <?php echo htmlspecialchars($companyName, ENT_QUOTES); ?>">Manage Company</a></li>
            <li class="breadcrumb-item active" aria-current="page"><?php echo $storeId ? 'Edit Store' : 'New Store'; ?></li>
        </ol>
    </nav>
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
    <script src="../assets/js/modules/superadmin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const STORE_ID = <?php echo $storeId; ?>;
        if (STORE_ID) {
            fetch(`../api/stores.php?token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`)
                .then(r => r.json())
                .then(data => {
                    const store = data.find(s => s.id == STORE_ID);
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
            }).then(() => {
                adminGoBack('saved');
            });
        });
    })();
    </script>
</body>
</html>
