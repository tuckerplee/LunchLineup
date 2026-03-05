<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false) {
    header('Location: ../index.php');
    exit;
}
$userId = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    http_response_code(400);
    echo 'Missing company_id';
    exit;
}
if (!in_array($companyId, $auth['companies'] ?? [], true)) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}
if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}
$stores = fetchStores($companyId);
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Settings</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <h1>Settings</h1>
    <div id="status" class="alert d-none"></div>
    <h2>Company Setting</h2>
    <form id="company-form" class="mb-5">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="mb-3">
            <label class="form-label">Name
                <input type="text" name="name" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Value
                <input type="text" name="value" class="form-control" required />
            </label>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Back</button>
    </form>
    <h2>Store Setting</h2>
    <form id="store-form">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="mb-3">
            <label class="form-label">Store
                <select name="store_id" class="form-select">
                    <?php foreach ($stores as $s) : ?>
                        <option value="<?php echo $s['id']; ?>"><?php echo htmlspecialchars($s['name']); ?></option>
                    <?php endforeach; ?>
                </select>
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Name
                <input type="text" name="name" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Value
                <input type="text" name="value" class="form-control" required />
            </label>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Back</button>
    </form>
    <h2>Break Settings</h2>
    <form id="break-form">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="mb-3">
            <label class="form-label">Store
                <select name="store_id" class="form-select">
                    <?php foreach ($stores as $s) : ?>
                        <option value="<?php echo $s['id']; ?>"><?php echo htmlspecialchars($s['name']); ?></option>
                    <?php endforeach; ?>
                </select>
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Max Concurrent Breaks
                <input type="number" name="max_concurrent" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Minimum Spacing (minutes)
                <input type="number" name="min_spacing" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Lunch Window Start
                <input type="time" name="lunch_start" class="form-control" required />
            </label>
        </div>
        <div class="mb-3">
            <label class="form-label">Lunch Window End
                <input type="time" name="lunch_end" class="form-control" required />
            </label>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Back</button>
    </form>
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script>
        const token = <?php echo json_encode($token); ?>;
        const COMPANY_ID = <?php echo $companyId; ?>;

        function showStatus(message, ok = true) {
            const el = document.getElementById('status');
            el.textContent = message;
            el.className = ok ? 'alert alert-success' : 'alert alert-danger';
        }

        document.getElementById('company-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const body = { name: form.name.value, value: form.value.value };
            const res = await fetch(`../admin-api/settings.php?token=${encodeURIComponent(token)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.status === 'ok') {
                showStatus('Setting saved.');
            } else {
                showStatus(data.message || 'Error saving setting', false);
            }
        });

        document.getElementById('store-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const body = {
                store_id: parseInt(form.store_id.value, 10),
                name: form.name.value,
                value: form.value.value
            };
            const res = await fetch(`../admin-api/settings.php?token=${encodeURIComponent(token)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.status === 'ok') {
                showStatus('Setting saved.');
            } else {
                showStatus(data.message || 'Error saving setting', false);
            }
        });

        document.getElementById('break-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            const form = e.target;
            const body = {
                store_id: parseInt(form.store_id.value, 10),
                maxConcurrent: parseInt(form.max_concurrent.value, 10),
                minSpacing: parseInt(form.min_spacing.value, 10),
                lunchStart: form.lunch_start.value,
                lunchEnd: form.lunch_end.value
            };
            const res = await fetch(`../admin-api/settings.php?token=${encodeURIComponent(token)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            const data = await res.json();
            if (data.status === 'ok') {
                showStatus('Setting saved.');
            } else {
                showStatus(data.message || 'Error saving setting', false);
            }
        });
    </script>
</body>
</html>
