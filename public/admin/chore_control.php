<?php
require_once __DIR__ . '/../../src/data.php';

$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false) {
    header('Location: ../index.php');
    exit;
}

$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
$storeId   = isset($_GET['store_id']) ? (int) $_GET['store_id'] : 0;
$userId    = (int) ($auth['sub'] ?? 0);
if ($companyId === 0 || $storeId === 0) {
    http_response_code(400);
    echo 'Missing company or store context.';
    exit;
}

$storeCompanyId = get_store_company_id($storeId);
if ($storeCompanyId !== $companyId) {
    http_response_code(403);
    echo 'Store does not belong to the selected company.';
    exit;
}

$hasAccess = !empty($auth['isSuperAdmin'])
    || is_company_admin($userId, $companyId)
    || user_has_role($userId, $storeId, 'chores')
    || user_has_role($userId, $storeId, 'schedule')
    || isAdmin($userId);

if (!$hasAccess) {
    header('Location: ../index.php');
    exit;
}

$superAdminContext = !empty($auth['isSuperAdmin']) && isset($_GET['superadmin']);
$companyName       = get_company_name($companyId) ?? '';
$stores            = fetchStores($companyId);
$storeName         = '';
foreach ($stores as $store) {
    if ((int) ($store['id'] ?? 0) === $storeId) {
        $storeName = $store['name'] ?? '';
        break;
    }
}
$dayOptions = [
    'sun' => 'Sunday',
    'mon' => 'Monday',
    'tue' => 'Tuesday',
    'wed' => 'Wednesday',
    'thu' => 'Thursday',
    'fri' => 'Friday',
    'sat' => 'Saturday',
];
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Chore Control</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-check.svg" type="image/svg+xml" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <?php if ($superAdminContext) : ?>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="../superadmin/company.php" data-title="Companies">Companies</a></li>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="../superadmin/chore_control.php" data-title="Chore Control">Select Company</a></li>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="../superadmin/chore_control.php?company_id=<?php echo $companyId; ?>" data-title="Chore Control — Stores">Select Store</a></li>
            <?php else : ?>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
                <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="select_store.php?company_id=<?php echo $companyId; ?>&next=chore_control.php&title=Chore+Control" data-title="Select Store">Select Store</a></li>
            <?php endif; ?>
            <li class="breadcrumb-item active" aria-current="page">Chore Control</li>
        </ol>
    </nav>
    <header class="mb-4">
        <h1 class="h3 mb-1">Chore Control</h1>
        <p class="text-muted mb-0">
            Company: <strong><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></strong>
            — Store: <strong><?php echo htmlspecialchars($storeName, ENT_QUOTES); ?></strong>
        </p>
    </header>
    <div id="choreAlert" class="alert d-none" role="alert"></div>
    <div class="row g-4">
        <div class="col-lg-4">
            <div class="card h-100">
                <div class="card-body d-flex flex-column">
                    <div class="d-flex align-items-center justify-content-between mb-3">
                        <h2 class="h5 mb-0">Templates</h2>
                        <div class="btn-group">
                            <button type="button" class="btn btn-outline-secondary btn-sm" id="refreshChores">Refresh</button>
                            <button type="button" class="btn btn-primary btn-sm" id="addChore">Add</button>
                        </div>
                    </div>
                    <div class="mb-2">
                        <input type="search" class="form-control form-control-sm" id="choreSearch" placeholder="Search chores" />
                    </div>
                    <div class="table-responsive border rounded" style="max-height: 28rem;">
                        <table class="table table-sm mb-0" id="choreTable">
                            <thead class="table-light">
                                <tr>
                                    <th scope="col">Name</th>
                                    <th scope="col" class="text-end">Priority</th>
                                </tr>
                            </thead>
                            <tbody id="choreTableBody"></tbody>
                        </table>
                    </div>
                    <p class="mt-3 mb-0 text-muted small">Select a template to edit its configuration. Use Add to start a brand new chore definition.</p>
                </div>
            </div>
        </div>
        <div class="col-lg-8">
            <form id="choreForm" class="card h-100">
                <div class="card-body">
                    <h2 class="h5">Template Settings</h2>
                    <input type="hidden" id="choreId" />
                    <div class="row g-3">
                        <div class="col-md-6">
                            <label for="choreName" class="form-label">Name</label>
                            <input type="text" class="form-control" id="choreName" placeholder="e.g. Restock condiments" required />
                        </div>
                        <div class="col-md-6">
                            <label for="chorePriority" class="form-label">Priority</label>
                            <input type="number" class="form-control" id="chorePriority" value="0" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreFrequency" class="form-label">Frequency</label>
                            <select id="choreFrequency" class="form-select">
                                <option value="once">One time</option>
                                <option value="daily">Daily</option>
                                <option value="weekly">Weekly</option>
                                <option value="monthly">Monthly</option>
                                <option value="per_shift">Per shift</option>
                            </select>
                        </div>
                        <div class="col-md-6">
                            <label for="choreInterval" class="form-label">Interval</label>
                            <input type="number" class="form-control" id="choreInterval" value="1" min="1" />
                        </div>
                        <div class="col-md-12">
                            <label for="choreInstructions" class="form-label">Instructions</label>
                            <textarea id="choreInstructions" class="form-control" rows="3" placeholder="Step-by-step instructions for staff"></textarea>
                        </div>
                        <div class="col-md-6">
                            <label for="choreWindowStart" class="form-label">Window Start</label>
                            <input type="time" class="form-control" id="choreWindowStart" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreWindowEnd" class="form-label">Window End</label>
                            <input type="time" class="form-control" id="choreWindowEnd" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreDaypart" class="form-label">Daypart</label>
                            <select id="choreDaypart" class="form-select">
                                <option value="">-- Any --</option>
                                <option value="open">Open</option>
                                <option value="mid">Mid</option>
                                <option value="close">Close</option>
                                <option value="custom">Custom</option>
                            </select>
                        </div>
                        <div class="col-md-6">
                            <label for="choreDeadline" class="form-label">Deadline Time</label>
                            <input type="time" class="form-control" id="choreDeadline" />
                        </div>
                        <div class="col-md-6">
                            <label class="form-label">Active Days</label>
                            <div class="d-flex flex-wrap gap-2" id="activeDayContainer">
                                <?php foreach ($dayOptions as $key => $label) : ?>
                                    <div class="form-check form-check-inline">
                                        <input class="form-check-input chore-active-day" type="checkbox" id="day-<?php echo $key; ?>" value="<?php echo $key; ?>" />
                                        <label class="form-check-label" for="day-<?php echo $key; ?>"><?php echo $label; ?></label>
                                    </div>
                                <?php endforeach; ?>
                            </div>
                        </div>
                        <div class="col-md-6">
                            <label for="choreEstimatedDuration" class="form-label">Estimated Duration (minutes)</label>
                            <input type="number" class="form-control" id="choreEstimatedDuration" min="0" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreAssignedTo" class="form-label">Default Assignee</label>
                            <input type="number" class="form-control" id="choreAssignedTo" min="0" placeholder="Staff ID (optional)" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreLeadTime" class="form-label">Lead Time (minutes)</label>
                            <input type="number" class="form-control" id="choreLeadTime" min="0" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreMinStaff" class="form-label">Minimum Staff Level</label>
                            <input type="number" class="form-control" id="choreMinStaff" min="0" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreMaxPerDay" class="form-label">Max Per Day</label>
                            <input type="number" class="form-control" id="choreMaxPerDay" min="0" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreMaxPerShift" class="form-label">Max Per Shift</label>
                            <input type="number" class="form-control" id="choreMaxPerShift" min="0" />
                        </div>
                        <div class="col-md-6">
                            <label for="choreMaxPerEmployee" class="form-label">Max Per Employee / Day</label>
                            <input type="number" class="form-control" id="choreMaxPerEmployee" min="0" />
                        </div>
                    </div>
                    <hr class="my-4" />
                    <div class="row g-3">
                        <div class="col-md-4">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="choreIsActive" checked />
                                <label class="form-check-label" for="choreIsActive">Active</label>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="choreAutoAssign" checked />
                                <label class="form-check-label" for="choreAutoAssign">Auto-assign enabled</label>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="choreAllowMultiple" />
                                <label class="form-check-label" for="choreAllowMultiple">Allow multiple assignees</label>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="choreExcludeCloser" />
                                <label class="form-check-label" for="choreExcludeCloser">Exclude closers</label>
                            </div>
                        </div>
                        <div class="col-md-4">
                            <div class="form-check">
                                <input class="form-check-input" type="checkbox" id="choreExcludeOpener" />
                                <label class="form-check-label" for="choreExcludeOpener">Exclude openers</label>
                            </div>
                        </div>
                    </div>
                </div>
                <div class="card-footer d-flex justify-content-between align-items-center">
                    <div>
                        <button type="submit" class="btn btn-primary" id="saveChore">Save</button>
                        <button type="button" class="btn btn-outline-danger ms-2" id="deleteChore">Delete</button>
                    </div>
                    <button type="button" class="btn btn-link" data-action="cancel">Close</button>
                </div>
            </form>
        </div>
    </div>
    <?php if ($superAdminContext) : ?>
        <script src="../assets/js/modules/superadmin-nav.js"></script>
    <?php else : ?>
        <script src="../assets/js/modules/admin-nav.js"></script>
    <?php endif; ?>
    <script src="../assets/js/modules/chore-control.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    window.STORE_ID = <?php echo $storeId; ?>;
    window.IS_SUPERADMIN_CONTEXT = <?php echo $superAdminContext ? 'true' : 'false'; ?>;
    ChoreControl.init({
        token: <?php echo json_encode($token, JSON_THROW_ON_ERROR); ?>,
        companyId: <?php echo $companyId; ?>,
        storeId: <?php echo $storeId; ?>,
    });
    </script>
</body>
</html>
