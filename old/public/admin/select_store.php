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
if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}
$next      = $_GET['next'] ?? '';
$baseTitle = $_GET['title'] ?? 'Store';
$stores    = fetchStores($companyId);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Select Store</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/building-storefront.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <h1>Select Store</h1>
    <?php if ($next === 'store.php') : ?>
        <button type="button" class="btn btn-primary mb-3" id="newBtn">Manage Stores</button>
    <?php endif; ?>
    <?php if (empty($stores)) : ?>
        <p>No stores available.</p>
    <?php else : ?>
        <ul class="list-group">
            <?php foreach ($stores as $s) : ?>
                <li class="list-group-item d-flex justify-content-between align-items-center">
                    <span><?php echo htmlspecialchars($s['name']); ?></span>
                    <button type="button" class="btn btn-primary btn-sm open-btn" data-id="<?php echo (int) $s['id']; ?>" data-name="<?php echo htmlspecialchars($s['name'], ENT_QUOTES); ?>">Open</button>
                </li>
            <?php endforeach; ?>
        </ul>
    <?php endif; ?>
    <script>
    (function () {
        const COMPANY_ID = <?php echo $companyId; ?>;
        const BASE_TITLE = <?php echo json_encode($baseTitle); ?>;
        const NEXT = <?php echo json_encode($next); ?>;
        document.querySelectorAll('.open-btn').forEach((btn) => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const name = btn.dataset.name;
                let url = '';
                if (NEXT === 'store.php') {
                    url = `${NEXT}?company_id=${COMPANY_ID}&id=${id}`;
                } else {
                    url = `${NEXT}?company_id=${COMPANY_ID}&store_id=${id}`;
                }
                const title = `${BASE_TITLE} - ${name}`;
                if (typeof openAdminModal === 'function') {
                    openAdminModal(url, title);
                } else {
                    window.location.href = url;
                }
            });
        });
        const newBtn = document.getElementById('newBtn');
        if (newBtn) {
            newBtn.addEventListener('click', () => {
                const url = `store.php?company_id=${COMPANY_ID}`;
                const title = 'New Store';
                if (typeof openAdminModal === 'function') {
                    openAdminModal(url, title);
                } else {
                    window.location.href = url;
                }
            });
        }
    })();
    </script>
</body>
</html>
