<?php
require_once __DIR__ . '/../../src/data.php';

$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}

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
$name = $_SESSION['name'];

$companyCount = count(fetchCompanies());
$userCount    = count(fetchUsers());
$logCount     = (int) $db->query('SELECT COUNT(*) FROM audit_logs')->fetchColumn();

$cards = [
    [
        'title' => 'Companies',
        'text'  => 'Create and edit companies.',
        'link'  => 'company.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/building-office.svg',
    ],
    [
        'title' => 'Chore Control',
        'text'  => 'Manage chore templates across stores.',
        'link'  => 'chore_control.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-check.svg',
    ],
    [
        'title' => 'Users',
        'text'  => 'Manage company users and admins.',
        'link'  => 'user.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/user-group.svg',
    ],
    [
        'title' => 'Logs',
        'text'  => 'Review access logs.',
        'link'  => 'logs.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/clipboard-document-list.svg',
    ],
    [
        'title' => 'Back End',
        'text'  => 'Rebuild the database schema.',
        'link'  => 'backend.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/wrench-screwdriver.svg',
    ],
    [
        'title' => 'Backup/Restore',
        'text'  => 'Create, restore or delete encrypted backups.',
        'link'  => 'backup.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-path.svg',
    ],
    [
        'title' => 'Tests',
        'text'  => 'Run backend test scripts.',
        'link'  => 'tests.php',
        'icon'  => 'https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/beaker.svg',
    ],
];
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>LunchLineup — Super Admin Portal</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
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
        <h1 class="text-center mb-4">Super Admin Portal</h1>
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
                        <div class="display-5"><span class="stat" data-target="<?php echo $userCount; ?>"><?php echo $userCount; ?></span></div>
                        <p class="mb-0 text-muted">Users</p>
                    </div>
                </div>
            </div>
            <div class="col-md-4">
                <div class="card bg-light dashboard-card">
                    <div class="card-body">
                        <div class="display-5"><span class="stat" data-target="<?php echo $logCount; ?>"><?php echo $logCount; ?></span></div>
                        <p class="mb-0 text-muted">Logs</p>
                    </div>
                </div>
            </div>
        </div>
        <div class="row row-cols-1 row-cols-sm-2 row-cols-md-3 g-4">
            <?php foreach ($cards as $card) : ?>
            <div class="col">
                <div class="card h-100 dashboard-card">
                    <div class="card-body d-flex flex-column">
                        <h5 class="card-title d-flex align-items-center gap-2">
                            <img src="<?php echo htmlspecialchars($card['icon'], ENT_QUOTES); ?>" alt="" class="card-icon" data-bs-toggle="tooltip" title="<?php echo htmlspecialchars($card['title'], ENT_QUOTES); ?>" />
                            <?php echo htmlspecialchars($card['title'], ENT_QUOTES); ?>
                        </h5>
                        <p class="card-text"><?php echo htmlspecialchars($card['text'], ENT_QUOTES); ?></p>
                        <button type="button" class="btn btn-primary mt-auto card-open" data-link="<?php echo $card['link']; ?>" data-title="<?php echo htmlspecialchars($card['title'], ENT_QUOTES); ?>" data-bs-toggle="tooltip" title="Open <?php echo htmlspecialchars($card['title'], ENT_QUOTES); ?>">Open</button>
                    </div>
                </div>
            </div>
            <?php endforeach; ?>
        </div>
    </div>
    <div class="modal fade" id="cardModal" tabindex="-1" aria-hidden="true">
        <div class="modal-dialog modal-xl">
            <div class="modal-content">
                <div class="modal-header">
                    <h5 class="modal-title" id="modalTitle"></h5>
                    <button type="button" class="btn-close" data-bs-dismiss="modal" aria-label="Close"></button>
                </div>
                <div class="modal-body" id="modalBody"></div>
            </div>
        </div>
    </div>
    <script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/js/bootstrap.bundle.min.js"></script>
    <script>
    const modalEl = document.getElementById('cardModal');
    const modalBody = document.getElementById('modalBody');
    document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach((el) => {
        new bootstrap.Tooltip(el);
    });
    function initBreadcrumbs() {
        modalBody.querySelectorAll('a[data-breadcrumb]').forEach((a) => {
            a.addEventListener('click', (e) => {
                e.preventDefault();
                const link = a.dataset.link;
                const title = a.dataset.title;
                if (link) {
                    openAdminModal(link, title);
                } else if (typeof adminModalClose === 'function') {
                    adminModalClose();
                }
            });
        });
    }
    function openAdminModal(url, title) {
        const modal = bootstrap.Modal.getOrCreateInstance(modalEl);
        if (title) {
            document.getElementById('modalTitle').textContent = title;
        }
        fetch(url)
            .then((r) => r.text())
            .then((html) => {
                const doc = new DOMParser().parseFromString(html, 'text/html');
                modalBody.innerHTML = doc.body.innerHTML;
                const scripts = Array.from(doc.querySelectorAll('script'));
                (function load(i) {
                    if (i === scripts.length) {
                        initBreadcrumbs();
                        modal.show();
                        return;
                    }
                    const old = scripts[i];
                    const s = document.createElement('script');
                    if (old.src) {
                        s.src = old.src;
                        s.onload = () => load(i + 1);
                        modalBody.appendChild(s);
                    } else {
                        const type = old.getAttribute('type');
                        if (type) {
                            s.type = type;
                        }
                        const shouldWrap = !type || type === 'text/javascript';
                        const content = old.textContent || '';
                        s.textContent = shouldWrap
                            ? `(function(){\n${content}\n})();`
                            : content;
                        modalBody.appendChild(s);
                        load(i + 1);
                    }
                })(0);
            });
    }
    document.querySelectorAll('.card-open').forEach(btn => {
        btn.addEventListener('click', () => {
            openAdminModal(btn.dataset.link, btn.dataset.title);
        });
    });
    window.openAdminModal = openAdminModal;
    window.adminModalClose = () => {
        const modal = bootstrap.Modal.getInstance(modalEl);
        if (modal) {
            modal.hide();
        }
    };
    modalEl.addEventListener('hidden.bs.modal', () => {
        if (window.ChoreControl && typeof window.ChoreControl.destroy === 'function') {
            try {
                window.ChoreControl.destroy();
            } catch (error) {
                console.error('Failed to reset chore control module', error);
            }
        }
        modalBody.innerHTML = '';
    });
    </script>
    <script>
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
