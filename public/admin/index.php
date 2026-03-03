<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false) {
    header('Location: ../index.php');
    exit;
}

$isSuperAdmin = !empty($auth['isSuperAdmin']);

session_start();
$db     = getDb();
$userId = (int) ($auth['sub'] ?? 0);
if (!isset($_SESSION['avatar'])) {
    $_SESSION['avatar'] = 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/user-circle.svg';
}
$avatar = $_SESSION['avatar'];
if (!isset($_SESSION['name'])) {
    $stmt = $db->prepare('SELECT name FROM staff WHERE id = ?');
    $stmt->execute([$userId]);
    $n = $stmt->fetchColumn();
    $_SESSION['name'] = $n !== false ? decryptField($n) : 'Profile';
}
$name       = $_SESSION['name'];
$companyIds = $auth['companies'] ?? [];
$companies  = array_filter(
    fetchCompanies(),
    static fn($c) => in_array((int) $c['id'], $companyIds, true)
);
$companyCount = count($companies);
$storeCount   = 0;
$staffCount   = 0;
foreach ($companies as $c) {
    $cid       = (int) $c['id'];
    $storeCount += count(fetchStores($cid));
    $staffCount += count(fetch_company_staff($cid));
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>LunchLineup — Admin Portal</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    <link rel="stylesheet" href="../assets/css/nav.css" />
</head>
<body class="gradient-bg">
    <nav class="navbar navbar-dark bg-dark">
        <div class="container-fluid">
            <a class="navbar-brand d-flex align-items-center gap-2" href="#">
                <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" alt="" class="brand-icon" />
                LunchLineup
            </a>
            <a class="top-nav-btn ms-auto me-2" href="../app.php" data-bs-toggle="tooltip" title="Return to LunchLineup">Return to LunchLineup</a>
            <a class="top-nav-btn me-2" href="../assets/templates/README.md" target="_blank" data-bs-toggle="tooltip" title="View help docs">Help</a>
            <div class="dropdown ms-2">
                <a href="#" class="d-flex align-items-center text-white text-decoration-none dropdown-toggle" id="userDropdown" data-bs-toggle="dropdown" aria-expanded="false">
                    <img src="<?php echo htmlspecialchars($avatar, ENT_QUOTES); ?>" alt="Avatar" class="avatar">
                    <span class="ms-2 d-none d-sm-inline"><?php echo htmlspecialchars($name, ENT_QUOTES); ?></span>
                </a>
                <ul class="dropdown-menu dropdown-menu-end" aria-labelledby="userDropdown">
                    <li><a class="dropdown-item" href="#">Profile</a></li>
                    <li><hr class="dropdown-divider"></li>
                    <li><a class="dropdown-item" href="../logout.php">Logout</a></li>
                </ul>
            </div>
        </div>
    </nav>
    <div class="container py-4">
        <h1 class="text-center mb-4">Admin Portal</h1>
        <div class="row mb-4 text-center">
            <div class="col-md-4">
                <div class="card bg-light dashboard-card">
                    <div class="card-body">
                        <div class="display-5"><span class="stat" data-target="<?php echo $companyCount; ?>"><?php echo $companyCount; ?></span></div>
                        <p class="mb-0 text-muted">Companies</p>
                    </div>
                </div>
            </div>
            <div class="col-md-4">
                <div class="card bg-light dashboard-card">
                    <div class="card-body">
                        <div class="display-5"><span class="stat" data-target="<?php echo $storeCount; ?>"><?php echo $storeCount; ?></span></div>
                        <p class="mb-0 text-muted">Stores</p>
                    </div>
                </div>
            </div>
            <div class="col-md-4">
                <div class="card bg-light dashboard-card">
                    <div class="card-body">
                        <div class="display-5"><span class="stat" data-target="<?php echo $staffCount; ?>"><?php echo $staffCount; ?></span></div>
                        <p class="mb-0 text-muted">Staff</p>
                    </div>
                </div>
            </div>
        </div>
        <div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 g-4">
            <?php if (!$isSuperAdmin) : ?>
                <?php foreach ($companies as $company) : ?>
            <div class="col">
                <div class="card bg-light h-100 dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/building-office.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="<?php echo htmlspecialchars($company['name'], ENT_QUOTES); ?>" />
                            <?php echo htmlspecialchars($company['name']); ?>
                        </h5>
                        <p class="card-text">Manage company resources.</p>
                        <a class="btn btn-primary mt-auto" href="company_dashboard.php?company_id=<?php echo (int) $company['id']; ?>" data-bs-toggle="tooltip" title="Open <?php echo htmlspecialchars($company['name'], ENT_QUOTES); ?>">Open</a>
                    </div>
                </div>
            </div>
                <?php endforeach; ?>
            <?php endif; ?>
            <div class="col">
                <div class="card bg-light h-100 dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Return to Calendar" />
                            Return to Calendar
                        </h5>
                        <p class="card-text">Back to the scheduling calendar.</p>
                        <a class="btn btn-primary mt-auto" href="../app.php" data-bs-toggle="tooltip" title="Open Return to Calendar">Open</a>
                    </div>
                </div>
            </div>
            <?php if ($isSuperAdmin) : ?>
            <div class="col">
                <div class="card bg-light h-100 dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/shield-check.svg" alt="" class="card-icon" data-bs-toggle="tooltip" title="Super Admin Dashboard" />
                            Super Admin Dashboard
                        </h5>
                        <p class="card-text">Access the super admin dashboard.</p>
                        <a class="btn btn-primary mt-auto" href="../superadmin/index.php" data-bs-toggle="tooltip" title="Open Super Admin Dashboard">Open</a>
                    </div>
                </div>
            </div>
            <?php endif; ?>
        </div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    <script>
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
        new bootstrap.Tooltip(el);
    });
    const prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    if (!prefersReduced) {
        if ('IntersectionObserver' in window) {
            const observer = new IntersectionObserver((entries) => {
                entries.forEach((entry) => {
                    if (entry.isIntersecting) {
                        entry.target.classList.add('animate-in');
                        observer.unobserve(entry.target);
                    }
                });
            });
            document.querySelectorAll('.dashboard-card').forEach((card) =>
                observer.observe(card)
            );
        } else {
            document
                .querySelectorAll('.dashboard-card')
                .forEach((card) => card.classList.add('animate-in'));
        }
    }
    </script>
    <script>
    document.querySelectorAll('.stat').forEach((el) => {
        const target = parseInt(el.dataset.target, 10) || 0;
        if (prefersReduced) {
            el.textContent = target;
            return;
        }
        el.textContent = '0';
        const step = () => {
            const current = parseInt(el.textContent, 10);
            if (current < target) {
                el.textContent = Math.min(
                    current + Math.ceil((target - current) / 10),
                    target
                );
                requestAnimationFrame(step);
            }
        };
        requestAnimationFrame(step);
    });
    </script>
</body>
</html>
