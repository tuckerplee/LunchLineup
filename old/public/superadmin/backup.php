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
        <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml" />
        <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    </head>
    <body class="p-4">
        <nav aria-label="breadcrumb" class="mb-3">
            <ol class="breadcrumb">
                <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
                <li class="breadcrumb-item active" aria-current="page">Backup/Restore</li>
            </ol>
        </nav>
        <h1>Select Company</h1>
        <ul class="list-group">
            <?php foreach ($companies as $company) : ?>
            <li class="list-group-item d-flex justify-content-between align-items-center">
                <span><?php echo htmlspecialchars($company['name']); ?></span>
                <button type="button" class="btn btn-primary btn-sm manage-btn" data-id="<?php echo (int) $company['id']; ?>" data-name="<?php echo htmlspecialchars($company['name'], ENT_QUOTES); ?>">Manage Backup</button>
            </li>
            <?php endforeach; ?>
        </ul>
        <script>
        document.querySelectorAll('.manage-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const url = `backup.php?company_id=${btn.dataset.id}`;
                const title = `Backup/Restore - ${btn.dataset.name}`;
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
$companies   = fetchCompanies();
$companyName = '';
foreach ($companies as $c) {
    if ((int) $c['id'] === $companyId) {
        $companyName = $c['name'];
        break;
    }
}

$config    = getConfig();
$backupDir = $config['backup_dir'] ?? (__DIR__ . '/../backups');
if (!is_dir($backupDir)) {
    mkdir($backupDir, 0755, true);
}
$slug = strtolower(preg_replace('/[^a-z0-9]+/i', '-', $companyName));
$companyDir = $backupDir . '/' . $slug;
if (!is_dir($companyDir)) {
    mkdir($companyDir, 0755, true);
}
$files = glob($companyDir . '/*/*.sql.enc');
usort($files, fn($a, $b) => filemtime($b) <=> filemtime($a));
$recentBackups = array_map(
    fn($f) => [
        'path' => ltrim(str_replace($backupDir . '/', '', $f), '/'),
        'time' => filemtime($f),
    ],
    array_slice($files, 0, 3)
);
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Backup/Restore</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml" />
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    <style>
    .card-header-tabs .nav-link {
        border: none;
        border-bottom: 2px solid transparent;
        color: inherit;
    }
    .card-header-tabs .nav-link.active {
        border-color: var(--bs-primary);
        color: var(--bs-primary);
    }
    </style>
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item"><a href="#" data-breadcrumb data-link="backup.php" data-title="Backup/Restore">Backup/Restore</a></li>
            <li class="breadcrumb-item active" aria-current="page"><?php echo htmlspecialchars($companyName, ENT_QUOTES); ?></li>
        </ol>
    </nav>
    <h1>Backup/Restore</h1>
    <p>Create an encrypted database backup or restore from an uploaded file.</p>
    <div class="card mb-3 shadow-sm">
        <div class="card-header">
            <ul class="nav nav-tabs card-header-tabs">
                <li class="nav-item">
                    <button id="tab-backup" class="nav-link active d-flex align-items-center gap-1" type="button">
                        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-down-tray.svg" alt="" width="16" height="16" />
                        Backup
                    </button>
                </li>
                <li class="nav-item">
                    <button id="tab-restore" class="nav-link d-flex align-items-center gap-1" type="button">
                        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-up-tray.svg" alt="" width="16" height="16" />
                        Restore
                    </button>
                </li>
            </ul>
        </div>
        <div class="card-body">
            <div id="backup-pane">
                <div class="border rounded p-3 mb-3">
                    <div class="mb-2">
                        <label for="backupLabel" class="form-label small mb-1">Label</label>
                        <input type="text" id="backupLabel" class="form-control form-control-sm" placeholder="Optional label" />
                    </div>
                    <div class="mb-2">
                        <label for="backupPassword" class="form-label small mb-1">Password</label>
                        <input type="password" id="backupPassword" class="form-control form-control-sm" />
                    </div>
                    <div class="form-check form-switch mb-3">
                        <input class="form-check-input" type="checkbox" id="autoDownload" checked />
                        <label class="form-check-label" for="autoDownload">Download automatically</label>
                    </div>
                    <button id="backupBtn" class="btn btn-primary d-flex align-items-center gap-1">
                        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-down-tray.svg" alt="" width="16" height="16" />
                        Create Backup
                    </button>
                </div>
            </div>
            <div id="restore-pane" class="d-none">
                <input type="file" id="restoreFile" class="form-control mb-2" />
                <input type="password" id="restorePassword" class="form-control mb-2" placeholder="Password" />
                <button id="restoreBtn" class="btn btn-danger d-flex align-items-center gap-1">
                    <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-up-tray.svg" alt="" width="16" height="16" />
                    Restore
                </button>
            </div>
        </div>
    </div>
    <h2 class="h5 mt-3 d-flex align-items-center gap-1">
        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/server-stack.svg" alt="" width="20" height="20" />
        Recent Backups
    </h2>
    <div id="backupBox" class="bg-light p-3 border rounded shadow-sm" style="height:200px;overflow:auto">
        <ul class="list-unstyled" id="backupList">
            <?php foreach ($recentBackups as $b) : ?>
            <li class="border rounded p-2 mb-2 d-flex justify-content-between align-items-center shadow-sm">
                <div class="d-flex align-items-center gap-2">
                    <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/archive-box.svg" alt="" width="20" height="20" />
                    <span><?php echo htmlspecialchars(date('Y-m-d H:i:s', $b['time'])); ?></span>
                </div>
                <div class="d-flex align-items-center gap-2">
                    <a class="btn btn-sm btn-primary d-flex align-items-center gap-1 download-link" href="../superadmin-api/backup.php?download=<?php echo rawurlencode($b['path']); ?>&token=<?php echo rawurlencode($token); ?>&company_id=<?php echo $companyId; ?>">
                        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-down-tray.svg" alt="" width="16" height="16" />
                        Download
                    </a>
                    <button type="button" class="btn btn-sm btn-danger d-flex align-items-center gap-1 restore-link d-none" data-file="<?php echo htmlspecialchars($b['path'], ENT_QUOTES); ?>">
                        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-up-tray.svg" alt="" width="16" height="16" />
                        Restore
                    </button>
                    <button type="button" class="btn btn-sm btn-outline-danger d-flex align-items-center gap-1 delete-link" data-file="<?php echo htmlspecialchars($b['path'], ENT_QUOTES); ?>">
                        <img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/trash.svg" alt="" width="16" height="16" />
                        Delete
                    </button>
                </div>
            </li>
            <?php endforeach; ?>
            <?php if (!$recentBackups) : ?>
            <li class="text-muted no-backups">No backups found.</li>
            <?php endif; ?>
        </ul>
    </div>
    <div id="progressOverlay" class="d-none position-fixed top-0 start-0 w-100 h-100 bg-dark bg-opacity-50 d-flex align-items-center justify-content-center">
        <div class="bg-white p-3 border" style="width:400px;">
            <h2 class="h5">Backup Progress</h2>
            <pre id="progressOutput" class="bg-light p-2 border mb-3" style="height:150px;overflow:auto"></pre>
            <div class="text-end">
                <a id="progressDownload" class="btn btn-primary d-none me-2" href="#">Download</a>
                <button id="progressRetry" class="btn btn-danger d-none me-2">Retry</button>
                <button id="progressClose" class="btn btn-secondary">Close</button>
            </div>
        </div>
    </div>
    <script src="../assets/js/modules/superadmin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const COMPANY_ID = window.COMPANY_ID;
        const overlay = document.getElementById('progressOverlay');
        const output = document.getElementById('progressOutput');
        const downloadBtn = document.getElementById('progressDownload');
        const retryBtn = document.getElementById('progressRetry');
        const closeBtn = document.getElementById('progressClose');
        const backupList = document.getElementById('backupList');
        const append = (text) => {
            output.textContent += text;
            output.scrollTop = output.scrollHeight;
        };
        const showOverlay = () => overlay.classList.remove('d-none');
        const hideOverlay = () => {
            overlay.classList.add('d-none');
            output.textContent = '';
            downloadBtn.classList.add('d-none');
            retryBtn.classList.add('d-none');
            downloadBtn.removeAttribute('href');
        };
        closeBtn.addEventListener('click', hideOverlay);
        retryBtn.addEventListener('click', () => {
            hideOverlay();
            startBackup();
        });
        const updateBackupButtons = () => {
            const restoreMode = tabRestore.classList.contains('active');
            backupList.querySelectorAll('.download-link').forEach((a) => a.classList.toggle('d-none', restoreMode));
            backupList.querySelectorAll('.restore-link').forEach((b) => b.classList.toggle('d-none', !restoreMode));
        };
        const addBackupItem = (path) => {
            const parts = path.split('/');
            let label = path;
            if (parts.length >= 3) {
                const date = parts[1];
                const name = parts[2].replace('.sql.enc', '');
                const match = name.match(/^(\d{2}-\d{2}-\d{2})(?:-(.+))?$/);
                if (match) {
                    const time = match[1].replace(/-/g, ':');
                    const suffix = match[2] ? ` (${match[2].replace(/-/g, ' ')})` : '';
                    label = `${date} ${time}${suffix}`;
                }
            }
            const li = document.createElement('li');
            li.className = 'border rounded p-2 mb-2 d-flex justify-content-between align-items-center shadow-sm';
            const link = `../superadmin-api/backup.php?download=${encodeURIComponent(path)}&token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`;
            li.innerHTML = `<div class="d-flex align-items-center gap-2"><img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/archive-box.svg" alt="" width="20" height="20" /><span>${label}</span></div><div class="d-flex align-items-center gap-2"><a class="btn btn-sm btn-primary d-flex align-items-center gap-1 download-link" href="${link}"><img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-down-tray.svg" alt="" width="16" height="16" />Download</a><button type="button" class="btn btn-sm btn-danger d-flex align-items-center gap-1 restore-link d-none" data-file="${path}"><img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-up-tray.svg" alt="" width="16" height="16" />Restore</button><button type="button" class="btn btn-sm btn-outline-danger d-flex align-items-center gap-1 delete-link" data-file="${path}"><img src="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/trash.svg" alt="" width="16" height="16" />Delete</button></div>`;
            backupList.prepend(li);
            const items = backupList.querySelectorAll('li');
            if (items.length > 3) {
                items[items.length - 1].remove();
            }
            const none = backupList.querySelector('.no-backups');
            if (none) {
                none.remove();
            }
            updateBackupButtons();
        };
        const backupPane = document.getElementById('backup-pane');
        const restorePane = document.getElementById('restore-pane');
        const tabBackup = document.getElementById('tab-backup');
        const tabRestore = document.getElementById('tab-restore');
        const labelInput = document.getElementById('backupLabel');
        const backupPassword = document.getElementById('backupPassword');
        const restorePassword = document.getElementById('restorePassword');
        const autoDownload = document.getElementById('autoDownload');
        tabBackup.addEventListener('click', () => {
            tabBackup.classList.add('active');
            tabRestore.classList.remove('active');
            backupPane.classList.remove('d-none');
            restorePane.classList.add('d-none');
            updateBackupButtons();
        });
        tabRestore.addEventListener('click', () => {
            tabRestore.classList.add('active');
            tabBackup.classList.remove('active');
            restorePane.classList.remove('d-none');
            backupPane.classList.add('d-none');
            updateBackupButtons();
        });
        updateBackupButtons();
        const startBackup = () => {
            const password = backupPassword.value;
            if (password === '') {
                alert('Enter a password.');
                return;
            }
            showOverlay();
            const params = new URLSearchParams({
                action: 'backup',
                token: TOKEN,
                company_id: COMPANY_ID,
            });
            const label = labelInput.value.trim();
            if (label !== '') {
                params.append('label', label);
            }
            fetch(`../superadmin-api/backup.php?${params.toString()}`, {
                method: 'POST',
                body: new URLSearchParams({ password }),
            })
                .then((r) => r.body.getReader())
                .then((reader) => {
                    const read = () => reader.read().then(({ done, value }) => {
                        if (done) {
                            const lines = output.textContent.trim().split('\n');
                            const last = lines[lines.length - 1] || '';
                            if (last.startsWith('DONE')) {
                                try {
                                    const data = JSON.parse(last.slice(5));
                                    const link = `../superadmin-api/${data.download}`;
                                    addBackupItem(data.file);
                                    downloadBtn.href = link;
                                    downloadBtn.classList.remove('d-none');
                                    if (autoDownload.checked) {
                                        window.location.href = link;
                                    }
                                } catch (e) {
                                    retryBtn.classList.remove('d-none');
                                }
                            } else {
                                retryBtn.classList.remove('d-none');
                            }
                            return;
                        }
                        append(new TextDecoder().decode(value));
                        return read();
                    });
                    return read();
                })
                .catch((err) => {
                    append(`Error: ${err.message}\n`);
                    retryBtn.classList.remove('d-none');
                });
        };
        document.getElementById('backupBtn').addEventListener('click', startBackup);
        document.getElementById('restoreBtn').addEventListener('click', () => {
            const fileInput = document.getElementById('restoreFile');
            if (!fileInput.files.length) {
                alert('Choose a file.');
                return;
            }
            const password = restorePassword.value;
            if (password === '') {
                alert('Enter a password.');
                return;
            }
            const fd = new FormData();
            fd.append('sql', fileInput.files[0]);
            fd.append('password', password);
            showOverlay();
            fetch(`../superadmin-api/backup.php?action=restore&token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                method: 'POST',
                body: fd,
            })
                .then((r) => r.body.getReader())
                .then((reader) => {
                    const read = () =>
                        reader.read().then(({ done, value }) => {
                            if (done) {
                                const lines = output.textContent.trim().split('\n');
                                const last = lines[lines.length - 1] || '';
                                if (last.startsWith('DONE')) {
                                    append('Restore complete.\n');
                                } else {
                                    retryBtn.classList.remove('d-none');
                                }
                                return;
                            }
                            append(new TextDecoder().decode(value));
                            return read();
                        });
                    return read();
                })
                .catch((err) => {
                    append(`Error: ${err.message}\n`);
                    retryBtn.classList.remove('d-none');
                });
        });
        backupList.addEventListener('click', (e) => {
            const btn = e.target.closest('button');
            if (!btn) {
                return;
            }
            if (btn.classList.contains('restore-link')) {
                const path = btn.dataset.file;
                const password = restorePassword.value;
                if (password === '') {
                    alert('Enter a password.');
                    return;
                }
                const fd = new FormData();
                fd.append('file', path);
                fd.append('password', password);
                showOverlay();
                fetch(`../superadmin-api/backup.php?action=restore&token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                    method: 'POST',
                    body: fd,
                })
                    .then((r) => r.body.getReader())
                    .then((reader) => {
                        const read = () =>
                            reader.read().then(({ done, value }) => {
                                if (done) {
                                    const lines = output.textContent.trim().split('\n');
                                    const last = lines[lines.length - 1] || '';
                                    if (last.startsWith('DONE')) {
                                        append('Restore complete.\n');
                                    } else {
                                        retryBtn.classList.remove('d-none');
                                    }
                                    return;
                                }
                                append(new TextDecoder().decode(value));
                                return read();
                            });
                        return read();
                    })
                    .catch((err) => {
                        append(`Error: ${err.message}\n`);
                        retryBtn.classList.remove('d-none');
                    });
            } else if (btn.classList.contains('delete-link')) {
                const path = btn.dataset.file;
                if (!confirm('Delete this backup?')) {
                    return;
                }
                fetch(`../superadmin-api/backup.php?action=delete&token=${encodeURIComponent(TOKEN)}&company_id=${COMPANY_ID}`, {
                    method: 'POST',
                    body: new URLSearchParams({ file: path }),
                })
                    .then((r) => r.json())
                    .then((data) => {
                        if (data.status === 'ok') {
                            btn.closest('li').remove();
                            if (backupList.querySelectorAll('li').length === 0) {
                                const li = document.createElement('li');
                                li.className = 'text-muted no-backups';
                                li.textContent = 'No backups found.';
                                backupList.appendChild(li);
                            }
                        } else {
                            alert('Delete failed.');
                        }
                    })
                    .catch(() => {
                        alert('Delete failed.');
                    });
            }
        });
    })();
    </script>
</body>
</html>
