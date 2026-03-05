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
                <li class="breadcrumb-item active" aria-current="page">Staff</li>
            </ol>
        </nav>
        <h1>Select Company</h1>
        <ul class="list-group">
            <?php foreach ($companies as $company) : ?>
            <li class="list-group-item d-flex justify-content-between align-items-center">
                <span><?php echo htmlspecialchars($company['name']); ?></span>
                <button type="button" class="btn btn-primary btn-sm manage-btn" data-id="<?php echo (int) $company['id']; ?>" data-name="<?php echo htmlspecialchars($company['name'], ENT_QUOTES); ?>">Manage Staff</button>
            </li>
            <?php endforeach; ?>
        </ul>
        <script>
        document.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = `staff.php?company_id=${btn.dataset.id}`;
                const title = `Staff - ${btn.dataset.name}`;
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
$staffId = isset($_GET['id']) ? (int) $_GET['id'] : 0;
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
    <title>Staff</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="company.php" data-title="Companies">Companies</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="company_manage.php?company_id=<?php echo $companyId; ?>" data-title="Manage <?php echo htmlspecialchars($companyName, ENT_QUOTES); ?>">Manage Company</a></li>
            <li class="breadcrumb-item active" aria-current="page"><?php echo $staffId ? 'Edit Staff' : 'New Staff'; ?></li>
        </ol>
    </nav>
    <h1><?php echo $staffId ? 'Edit Staff' : 'New Staff'; ?></h1>
    <form id="staffForm" class="mb-3">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <div class="mb-3">
            <label for="name" class="form-label">Name</label>
            <input type="text" class="form-control" id="name" required />
        </div>
        <div class="mb-3">
            <label for="lunchDuration" class="form-label">Lunch Duration (minutes)</label>
            <input type="number" class="form-control" id="lunchDuration" value="30" />
        </div>
        <div class="mb-3">
            <label for="registers" class="form-label">Preferred Registers</label>
            <input type="text" class="form-control" id="registers" placeholder="1,2,3" />
        </div>
        <div class="mb-3">
            <label for="tasks" class="form-label">Preferred Chore</label>
            <select id="tasks" class="form-select" multiple size="5">
                <option value="" disabled>Add chores to assign preference</option>
            </select>
        </div>
        <div class="mb-3">
            <label for="companyId" class="form-label">Company</label>
            <select id="companyId" class="form-select"></select>
        </div>
        <div class="mb-3">
            <label for="storeId" class="form-label">Store</label>
            <select id="storeId" class="form-select">
                <option value="">-- None --</option>
            </select>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" data-action="cancel">Cancel</button>
    </form>
    <script src="../assets/js/modules/superadmin-nav.js"></script>
    <script src="../assets/js/modules/superadmin-staff.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    window.STAFF_ID = <?php echo $staffId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        SuperAdminStaff.initStaffForm(TOKEN, COMPANY_ID, STAFF_ID, { superAdmin: true });
    })();
    </script>
</body>
</html>
