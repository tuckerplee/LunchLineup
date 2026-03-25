<?php
require_once __DIR__ . '/../../src/data.php';

$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}

$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
$storeId   = isset($_GET['store_id']) ? (int) $_GET['store_id'] : 0;

if ($companyId > 0 && $storeId > 0) {
    header('Location: ../admin/chore_control.php?company_id=' . $companyId . '&store_id=' . $storeId . '&superadmin=1');
    exit;
}

if ($companyId === 0) {
    $companies = fetchCompanies();
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>Select Company — Chore Control</title>
        <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-check.svg" type="image/svg+xml" />
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    </head>
    <body class="p-4">
        <nav aria-label="breadcrumb" class="mb-3">
            <ol class="breadcrumb">
                <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
                <li class="breadcrumb-item active" aria-current="page">Chore Control</li>
            </ol>
        </nav>
        <h1 class="h4 mb-3">Select Company</h1>
        <p class="text-muted">Choose a company to manage its chore templates.</p>
        <ul class="list-group">
            <?php foreach ($companies as $company) : ?>
                <li class="list-group-item d-flex justify-content-between align-items-center">
                    <span><?php echo htmlspecialchars($company['name'] ?? '', ENT_QUOTES); ?></span>
                    <button type="button" class="btn btn-primary btn-sm select-company" data-id="<?php echo (int) ($company['id'] ?? 0); ?>" data-name="<?php echo htmlspecialchars($company['name'] ?? '', ENT_QUOTES); ?>">Manage</button>
                </li>
            <?php endforeach; ?>
        </ul>
        <script>
        document.querySelectorAll('.select-company').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const title = `Chore Control — ${btn.dataset.name}`;
                const url = `chore_control.php?company_id=${id}`;
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

$stores = fetchStores($companyId);
$companyName = '';
foreach (fetchCompanies() as $company) {
    if ((int) ($company['id'] ?? 0) === $companyId) {
        $companyName = $company['name'] ?? '';
        break;
    }
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Select Store — Chore Control</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-check.svg" type="image/svg+xml" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="chore_control.php" data-title="Chore Control">Chore Control</a></li>
            <li class="breadcrumb-item active" aria-current="page">Stores</li>
        </ol>
    </nav>
    <h1 class="h4 mb-3">Select Store</h1>
    <p class="text-muted">Company: <strong><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></strong></p>
    <?php if (empty($stores)) : ?>
        <p>No stores found for this company.</p>
    <?php else : ?>
        <ul class="list-group">
            <?php foreach ($stores as $store) : ?>
                <li class="list-group-item d-flex justify-content-between align-items-center">
                    <span><?php echo htmlspecialchars($store['name'] ?? '', ENT_QUOTES); ?></span>
                    <button type="button" class="btn btn-primary btn-sm open-store" data-id="<?php echo (int) ($store['id'] ?? 0); ?>" data-name="<?php echo htmlspecialchars($store['name'] ?? '', ENT_QUOTES); ?>">Open</button>
                </li>
            <?php endforeach; ?>
        </ul>
    <?php endif; ?>
    <script>
    const companyId = <?php echo $companyId; ?>;
    document.querySelectorAll('.open-store').forEach((btn) => {
        btn.addEventListener('click', () => {
            const storeId = btn.dataset.id;
            const title = `Chore Control — ${btn.dataset.name}`;
            const url = `chore_control.php?company_id=${companyId}&store_id=${storeId}`;
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
