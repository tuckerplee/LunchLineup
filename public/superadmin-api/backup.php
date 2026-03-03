<?php
require_once __DIR__ . '/../../src/data.php';

header('X-Accel-Buffering: no');
$method = $_SERVER['REQUEST_METHOD'];
$action = $_GET['action'] ?? '';
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}
set_audit_user((int) ($auth['sub'] ?? 0));
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    http_response_code(400);
    echo 'Missing company_id';
    exit;
}
set_audit_company($companyId);

$config    = getConfig();
$backupDir = $config['backup_dir'] ?? (__DIR__ . '/../backups');
if (!is_dir($backupDir)) {
    mkdir($backupDir, 0755, true);
}

$name = get_company_name($companyId) ?? ('company-' . $companyId);
$slug = strtolower(preg_replace('/[^a-z0-9]+/i', '-', $name));
$companyDir = $backupDir . '/' . $slug;
if (!is_dir($companyDir)) {
    mkdir($companyDir, 0755, true);
}
$companyReal = realpath($companyDir);

if ($method === 'GET' && isset($_GET['download'])) {
    $rel  = ltrim((string) $_GET['download'], '/');
    $path = realpath($backupDir . '/' . $rel);
    if ($path === false || !str_starts_with($path, $companyReal . DIRECTORY_SEPARATOR) || !is_file($path)) {
        http_response_code(404);
        echo 'Not found';
        exit;
    }
    header('Content-Type: application/octet-stream');
    header('Content-Disposition: attachment; filename="' . basename($path) . '"');
    readfile($path);
    exit;
}

if ($method === 'POST' && $action === 'backup') {
    header('Content-Type: text/plain');
    $password = $_POST['password'] ?? '';
    if ($password === '') {
        http_response_code(400);
        echo "Missing password\n";
        exit;
    }
    $dateDir   = date('Y-m-d');
    $time      = date('H-i-s');
    $label     = trim($_GET['label'] ?? '');
    $labelSlug = $label !== '' ? '-' . strtolower(preg_replace('/[^a-z0-9]+/i', '-', $label)) : '';
    $dir       = $companyDir . '/' . $dateDir;
    if (!is_dir($dir)) {
        mkdir($dir, 0755, true);
    }
    $tmpFile = $dir . '/' . $time . $labelSlug . '.sql.enc';
    echo "Starting backup...\n";
    @ob_flush();
    flush();
    require_once __DIR__ . '/../../scripts/backup.php';
    $progress = static function (string $msg): void {
        echo $msg;
        @ob_flush();
        flush();
    };
    $output   = '';
    $exitCode = scheduler_backup_run($tmpFile, $password, $output, $progress);
    if ($output !== '') {
        echo $output;
    }
    if ($exitCode === 0) {
        auditLog('backup', 'database');
        $rel = $slug . '/' . $dateDir . '/' . $time . $labelSlug . '.sql.enc';
        $url = 'backup.php?download=' . rawurlencode($rel)
            . '&token=' . rawurlencode($token)
            . '&company_id=' . $companyId;
        echo 'DONE ' . json_encode(['status' => 'ok', 'download' => $url, 'file' => $rel]);
    } else {
        echo "ERROR\n";
    }
    exit;
}

if ($method === 'POST' && $action === 'restore') {
    header('Content-Type: text/plain');
    $password = $_POST['password'] ?? '';
    if ($password === '') {
        http_response_code(400);
        echo "Missing password\n";
        exit;
    }
    $fileParam = $_POST['file'] ?? '';
    $tmp       = '';
    if ($fileParam !== '') {
        $rel = ltrim($fileParam, '/');
        $tmp = realpath($backupDir . '/' . $rel) ?: '';
        if ($tmp === '' || !str_starts_with($tmp, $companyReal . DIRECTORY_SEPARATOR) || !is_file($tmp)) {
            http_response_code(400);
            echo "Invalid file\n";
            exit;
        }
    } else {
        if (!isset($_FILES['sql'])) {
            http_response_code(400);
            echo "Missing file\n";
            exit;
        }
        $tmp = $_FILES['sql']['tmp_name'] ?? '';
        if (!is_uploaded_file($tmp)) {
            http_response_code(400);
            echo "Invalid upload\n";
            exit;
        }
    }
    echo "Starting restore...\n";
    @ob_flush();
    flush();
    require_once __DIR__ . '/../../scripts/restore.php';
    $progress = static function (string $msg): void {
        echo $msg;
        @ob_flush();
        flush();
    };
    $output   = '';
    $exitCode = scheduler_restore_run($tmp, $password, $output, $progress);
    if ($fileParam === '') {
        unlink($tmp);
    }
    if ($output !== '') {
        echo $output;
    }
    if ($exitCode === 0) {
        auditLog('restore', 'database');
        echo "\nDONE {\"status\":\"ok\"}\n";
    } else {
        echo "\nERROR\n";
    }
    exit;
}

if ($method === 'POST' && $action === 'delete') {
    header('Content-Type: application/json');
    $rel = ltrim((string) ($_POST['file'] ?? ''), '/');
    if ($rel === '') {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Missing file']);
        exit;
    }
    $path = realpath($backupDir . '/' . $rel);
    if ($path === false || !str_starts_with($path, $companyReal . DIRECTORY_SEPARATOR) || !is_file($path)) {
        http_response_code(400);
        echo json_encode(['status' => 'error', 'message' => 'Invalid file']);
        exit;
    }
    if (!unlink($path)) {
        http_response_code(500);
        echo json_encode(['status' => 'error', 'message' => 'Delete failed']);
        exit;
    }
    auditLog('delete', 'backup');
    echo json_encode(['status' => 'ok']);
    exit;
}

http_response_code(405);
echo 'Method not allowed';
