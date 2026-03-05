<?php
$config = __DIR__ . '/../config.php';
if (!is_readable($config)) {
    header('Location: setup.php');
    exit;
}

header(
    "Content-Security-Policy: " .
    "default-src 'self'; " .
    "connect-src 'self' https://cdn.jsdelivr.net; " .
    "script-src 'self' 'unsafe-inline' https://cdn.tailwindcss.com https://cdn.jsdelivr.net https://static.cloudflareinsights.com; " .
    "style-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net https://fonts.googleapis.com; " .
    "img-src 'self' data: https://cdn.jsdelivr.net https://images.unsplash.com https://raw.githubusercontent.com; " .
    "font-src 'self' https://fonts.gstatic.com https://cdn.jsdelivr.net;"
);

require_once __DIR__ . '/../src/data.php';

// Authenticate using JWT token stored in cookie
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false) {
    header('Location: login.php');
    exit;
}
$userId = (int) ($auth['sub'] ?? 0);
$companyId = (int) ($auth['company_id'] ?? ($auth['companies'][0] ?? 0));
$db     = getDb();
$stmt   = $db->prepare('SELECT home_store_id FROM users WHERE id = ?');
$stmt->execute([$userId]);
$storeId        = (int) ($stmt->fetchColumn() ?: 0);
$isCompanyAdmin = $companyId ? is_company_admin($userId, $companyId) : false;
$allStores      = fetchStores($companyId);
if ($isCompanyAdmin) {
    $stores = $allStores;
} else {
    $stores = array_values(array_filter(
        $allStores,
        static fn($s) => in_array((int) $s['id'], $auth['stores'] ?? [], true)
    ));
}
$requestedStoreId = isset($_GET['store_id']) ? (int) $_GET['store_id'] : 0;
$storeIds         = array_map(static fn($s) => (int) $s['id'], $stores);
if ($requestedStoreId && in_array($requestedStoreId, $storeIds, true)) {
    $storeId = $requestedStoreId;
}
if ($storeId === 0 && $stores) {
    $storeId = (int) $stores[0]['id'];
}

$initialDate = null;
if (isset($_GET['date'])) {
    $requestedDate = (string) $_GET['date'];
    if (preg_match('/^\d{4}-\d{2}-\d{2}$/', $requestedDate) === 1) {
        $parsedDate = DateTime::createFromFormat('Y-m-d', $requestedDate);
        if ($parsedDate !== false) {
            $initialDate = $parsedDate->format('Y-m-d');
        }
    }
}

if (!$allStores) {
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>No Stores - LunchLineup</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    </head>
    <body class="p-4">
        <h2>No stores configured</h2>
        <p>You need to create a store before using the scheduler.</p>
        <?php if ($isCompanyAdmin) : ?>
            <a class="btn btn-primary" href="admin/company_dashboard.php?company_id=<?php echo $companyId; ?>">Manage Stores</a>
        <?php else : ?>
            <p>Please contact an administrator.</p>
        <?php endif; ?>
    </body>
    </html>
    <?php
    exit;
}

if (!$stores) {
    ?>
    <!DOCTYPE html>
    <html lang="en">
    <head>
        <meta charset="UTF-8" />
        <title>No Store Access - LunchLineup</title>
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    </head>
    <body class="p-4">
        <h2>No store access</h2>
        <?php if ($isCompanyAdmin) : ?>
            <p>You have no stores assigned. Add a store in the admin panel and assign yourself to it.</p>
            <a class="btn btn-primary" href="admin/company_dashboard.php?company_id=<?php echo $companyId; ?>">Manage Stores</a>
        <?php else : ?>
            <p>Your account isn't linked to a store. Please contact an administrator.</p>
        <?php endif; ?>
    </body>
    </html>
    <?php
    exit;
}
?>

<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>LunchLineup</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <script src="https://cdn.tailwindcss.com"></script>
    <link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700&display=swap" rel="stylesheet">
    <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/flatpickr/dist/flatpickr.min.css">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="stylesheet" href="assets/css/base.css">
    <link rel="stylesheet" href="assets/css/scheduler.css">
    <link rel="stylesheet" href="assets/css/print.css">
    <script src="https://cdn.jsdelivr.net/npm/flatpickr"></script>
    <script>
        let API_TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const COMPANY_ID = <?php echo (int) $companyId; ?>;
        const CURRENT_STORE_ID = <?php echo (int) $storeId; ?>;
        const INITIAL_DATE = <?php echo json_encode($initialDate); ?>;
    </script>
</head>
<body class="min-h-screen p-6 md:p-8">
    <!-- Toast notification -->
    <div id="toast" class="toast">
        <div id="toastIcon" class="toast-icon"></div>
        <div id="toastMessage" class="toast-message"></div>
        <div class="toast-close" onclick="hideToast()">×</div>
    </div>
    
    <!-- Employee Name Dropdown (positioned by JS) -->
    <div id="employeeNameDropdown" class="employee-name-dropdown">
        <!-- Options will be added dynamically -->
    </div>
    
    <div class="container mx-auto max-w-screen-xl px-4 md:px-6">
        <!-- Header -->
        <nav class="panel rounded-xl p-4 mb-6 flex flex-col md:flex-row justify-between items-center gap-3">
            <h1 class="text-3xl font-bold text-primary">LunchLineup</h1>
            <div class="d-flex flex-wrap align-items-center gap-2 top-menu">
                <?php if ($isCompanyAdmin) : ?>
                    <a href="admin/index.php" class="btn btn-secondary btn-sm d-flex align-items-center gap-1 no-print" title="Admin">
                        <i class="bi bi-gear-fill"></i>
                        <span class="d-none d-md-inline">Admin</span>
                    </a>
                <?php endif; ?>
                <a href="logout.php" class="btn btn-outline-secondary btn-sm d-flex align-items-center gap-1 no-print" title="Logout">
                    <i class="bi bi-box-arrow-right"></i>
                    <span class="d-none d-md-inline">Logout</span>
                </a>
                <?php if (count($stores) > 1) : ?>
                    <div class="d-flex align-items-center gap-1 no-print">
                        <label for="storeSelector" class="form-label mb-0">Store:</label>
                        <select id="storeSelector" class="form-select form-select-sm" aria-label="Select store">
                            <?php foreach ($stores as $s) : ?>
                                <option value="<?php echo (int) $s['id']; ?>"<?php if ((int) $s['id'] === $storeId) { ?> selected<?php } ?>>
                                    <?php echo htmlspecialchars($s['name'], ENT_QUOTES); ?>
                                </option>
                            <?php endforeach; ?>
                        </select>
                    </div>
                <?php endif; ?>
                <div class="schedule-date-selector panel rounded-lg d-flex align-items-center gap-1 px-2 py-1">
                    <button id="prevDate" class="date-nav-btn btn btn-sm rounded-circle p-1" title="Previous day">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M15 19l-7-7 7-7" />
                        </svg>
                    </button>
                    <input type="text" id="currentDateDisplay" class="date-display font-semibold text-center" />
                    <button id="nextDate" class="date-nav-btn btn btn-sm rounded-circle p-1" title="Next day">
                        <svg xmlns="http://www.w3.org/2000/svg" class="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke-width="2" stroke="currentColor">
                            <path stroke-linecap="round" stroke-linejoin="round" d="M9 5l7 7-7 7" />
                        </svg>
                    </button>
                </div>
                <div class="dropdown no-print">
                    <button class="btn btn-primary btn-sm dropdown-toggle d-flex align-items-center gap-1" type="button" id="actionsDropdown" data-bs-toggle="dropdown" aria-expanded="false">
                        <i class="bi bi-list"></i>
                        <span class="d-none d-md-inline">Actions</span>
                    </button>
                    <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="actionsDropdown">
                        <li>
                            <button id="importButton" class="dropdown-item d-flex align-items-center gap-2">
                                <i class="bi bi-upload"></i>
                                <span>Import</span>
                            </button>
                        </li>
                        <li>
                            <button id="clearButton" class="dropdown-item d-flex align-items-center gap-2">
                                <i class="bi bi-trash"></i>
                                <span>Clear</span>
                            </button>
                        </li>
                        <li>
                            <button id="printButton" class="dropdown-item d-flex align-items-center gap-2">
                                <i class="bi bi-printer"></i>
                                <span>Print</span>
                            </button>
                        </li>
                    </ul>
                </div>
                <input type="file" id="importPdfInput" accept="application/pdf" class="d-none">
            </div>
        </nav>

        <!-- Print-only header -->
        <div class="print-only print-header">
            Staff Schedule - <span id="printDateDisplay"></span>
        </div>

        <div class="flex flex-col lg:flex-row gap-4">
            <!-- Main Schedule Panel -->
            <div class="panel rounded-xl p-4 flex-grow">
                <div class="flex justify-between items-center mb-4">
                    <h2 class="text-xl text-gray-800">DAILY SCHEDULE</h2>
                    <div class="flex space-x-2 no-print">
                        <select id="templateSelector" class="bg-white border border-gray-300 rounded px-2 py-1">
                            <option value="">Load Template...</option>
                        </select>
                        <select id="employeeSelector" class="bg-white border border-gray-300 rounded px-2 py-1">
                            <option value="">Add Employee...</option>
                            <!-- Employee options will be loaded from JS -->
                        </select>
                        <button id="addEmployee" class="btn btn-primary font-bold py-1 px-3 rounded">
                            <img src="https://raw.githubusercontent.com/tailwindlabs/heroicons/v2.2.0/optimized/20/solid/plus.svg" class="h-4 w-4 inline-block mr-1" alt="add"/>
                            Add
                        </button>
                    </div>
                </div>

                <div class="overflow-x-auto">
                    <table class="w-full text-base print-compact" id="scheduleTable">
                        <thead>
                            <tr class="bg-gray-100 border-b border-gray-300">
                                <th class="text-left py-3 px-4 w-8"></th>
                                <th class="text-left py-3 px-4">Employee</th>
                                <th class="text-left py-3 px-4">Shift</th>
                                <th class="text-left py-3 px-4">POS #</th>
                                <th class="text-left py-3 px-4">Break 1</th>
                                <th class="text-left py-3 px-4">Lunch</th>
                                <th class="text-left py-3 px-4">Break 2</th>
                                <th class="text-left py-3 px-4">Chores</th>
                                <th class="text-left py-3 px-4 no-print">Actions</th>
                            </tr>
                        </thead>
                        <tbody id="scheduleBody">
                            <!-- Schedule data will be loaded dynamically -->
                        </tbody>
                    </table>
                </div>
                
                <!-- Break Timeline Visualization -->
                <div class="mt-6 mb-2">
                    <h3 class="text-md font-bold text-gray-700 mb-2">Break Timeline (7AM - 10PM)</h3>
                    <div id="breakTimelineContainer" class="break-timeline-container">
                        <!-- Break timeline will be rendered here -->
                    </div>
                    <div class="flex justify-between text-xs text-gray-500 mt-1">
                        <span>7AM</span>
                        <span>9AM</span>
                        <span>11AM</span>
                        <span>1PM</span>
                        <span>3PM</span>
                        <span>5PM</span>
                        <span>7PM</span>
                        <span>9PM</span>
                    </div>
                    <div class="flex items-center text-xs text-gray-600 mt-3 gap-4">
                        <div class="flex items-center">
                            <div class="w-3 h-3 bg-blue-300 mr-1 rounded-sm"></div>
                            <span>Break 1</span>
                        </div>
                        <div class="flex items-center">
                            <div class="w-3 h-3 bg-yellow-300 mr-1 rounded-sm"></div>
                            <span>Lunch</span>
                        </div>
                        <div class="flex items-center">
                            <div class="w-3 h-3 bg-green-300 mr-1 rounded-sm"></div>
                            <span>Break 2</span>
                        </div>
                        <div class="flex items-center">
                            <div class="w-3 h-3 bg-red-400 mr-1 rounded-sm"></div>
                            <span>Overlap</span>
                        </div>
                    </div>
                </div>
            </div>

            <!-- Side Panel -->
            <div class="lg:w-1/3 space-y-4">
                <!-- Schedule Summary -->
                <div class="panel rounded-xl p-4">
                    <h2 class="text-xl text-gray-800 mb-3">SCHEDULE SUMMARY</h2>
                    <div class="space-y-2">
                        <div class="flex justify-between">
                            <span class="text-gray-600">Total Employees:</span>
                            <span class="font-bold" id="totalEmployees">0</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-600">Morning Shift (Before 12PM):</span>
                            <span class="font-bold" id="morningShift">0</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-600">Afternoon Shift (After 12PM):</span>
                            <span class="font-bold" id="afternoonShift">0</span>
                        </div>
                        <div class="flex justify-between">
                            <span class="text-gray-600">Total Hours Scheduled:</span>
                            <span class="font-bold" id="totalHours">0.0</span>
                        </div>
                    </div>
                </div>

                <!-- Chore List -->
                <div id="choreList" class="panel rounded-xl p-4 chore-list-section">
                    <h2 class="text-xl text-gray-800 mb-3">CHORE LIST</h2>
                    <ul id="choreListItems" class="list-disc pl-5 space-y-1">
                        <!-- Chores will be populated by JavaScript -->
                    </ul>
                </div>
            </div>
        </div>
    </div>
    <?php include __DIR__ . '/../src/views/modals.php'; ?>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    <script src="assets/js/modules/state.js"></script>
    <script src="assets/js/modules/utils.js"></script>
    <script src="assets/js/modules/events.js"></script>
    <script type="module" src="assets/js/modules/schedule.js"></script>
    <script>
        document.addEventListener("DOMContentLoaded", async () => {
            try {
                const res = await fetch(`admin-api/templates.php?token=${encodeURIComponent(API_TOKEN)}&company_id=${COMPANY_ID}`);
                const data = await res.json();
                if (Array.isArray(data) && typeof window.setTemplates === "function") {
                    window.setTemplates(data);
                }
            } catch (err) {}
        });
    </script>
    <script type="module" src="assets/js/modules/modals.js"></script>
    <script type="module" src="assets/js/main.js"></script>

</body>
</html>
