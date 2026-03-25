<?php
require_once __DIR__ . '/../../src/data.php';
$token     = $_COOKIE['token'] ?? '';
$auth      = verify_api_token($token);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if (
    $auth === false
    || $companyId === 0
    || (
        empty($auth['isSuperAdmin'])
        && !is_company_admin((int) ($auth['sub'] ?? 0), $companyId)
    )
) {
    header('Location: ../index.php');
    exit;
}
$staffId     = isset($_GET['id']) ? (int) $_GET['id'] : 0;
$companyName = get_company_name($companyId) ?? '';
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Staff</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="company_manage.php?company_id=<?php echo $companyId; ?>" data-title="Manage Company">Manage Company</a></li>
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
            <select id="companyId" class="form-select">
                <option value="<?php echo $companyId; ?>"><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></option>
            </select>
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
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script src="../assets/js/modules/admin-staff.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    window.STAFF_ID = <?php echo $staffId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        AdminStaff.initStaffForm(TOKEN, COMPANY_ID, STAFF_ID);
    })();
    </script>
</body>
</html>

