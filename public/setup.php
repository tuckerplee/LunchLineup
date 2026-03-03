<?php
declare(strict_types=1);
ini_set('display_errors','1');
error_reporting(E_ALL);

function applySqlFile(PDO $db, string $file): void {
    if (!is_file($file)) throw new RuntimeException("Missing SQL file: $file");
    $sql = file_get_contents($file);
    // Split on semicolon followed by newline to avoid partial splits
    foreach (preg_split('/;\s*\R/', $sql) as $stmt) {
        $stmt = trim($stmt);
        if ($stmt !== '') $db->exec($stmt);
    }
}

function dropAllTables(PDO $db): void {
    $db->exec('SET FOREIGN_KEY_CHECKS=0');
    $stmt = $db->query("
        SELECT TABLE_NAME
        FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_TYPE='BASE TABLE'
    ");
    $tables = $stmt->fetchAll(PDO::FETCH_COLUMN);
    foreach ($tables as $t) {
        $db->exec("DROP TABLE IF EXISTS `{$t}`");
    }
    $db->exec('SET FOREIGN_KEY_CHECKS=1');
}

$installed = false;
$error = '';
$stats = [];

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    $host        = trim($_POST['host']        ?? 'localhost');
    $dbname      = trim($_POST['dbname']      ?? 'schedule_db');
    $user        = trim($_POST['user']        ?? '');
    $pass        = $_POST['pass']            ?? '';
    $companyName = trim($_POST['company_name'] ?? '');
    $storeName   = trim($_POST['store_name']   ?? '');
    $adminName   = trim($_POST['admin_name']   ?? '');
    $adminUsername = trim($_POST['admin_username']  ?? '');
    $adminPass   = trim($_POST['admin_pass']   ?? '');
    $overwrite   = isset($_POST['overwrite']) && $_POST['overwrite'] === '1';

    require_once __DIR__ . '/../src/crypto.php';
    $jwtSecret  = bin2hex(random_bytes(32));
    $appKey     = base64_encode(random_bytes(32));
    $_ENV['APP_KEY'] = $appKey;

    $backupDir = realpath(__DIR__ . '/backups') ?: __DIR__ . '/backups';
    if (!is_dir($backupDir) || !is_writable($backupDir)) {
        throw new RuntimeException('Backup directory is missing or not writable: ' . $backupDir);
    }

    try {
        // one server PDO to create DB
        $server = new PDO("mysql:host={$host};charset=utf8mb4", $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::MYSQL_ATTR_MULTI_STATEMENTS => true,
        ]);
        $server->exec(sprintf(
            'CREATE DATABASE IF NOT EXISTS `%s` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci',
            $dbname
        ));

        // main DB PDO for EVERYTHING
        $db = new PDO("mysql:host={$host};dbname={$dbname};charset=utf8mb4", $user, $pass, [
            PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
            PDO::MYSQL_ATTR_MULTI_STATEMENTS => true,
        ]);

        // optional: detect existing schema
        $hasAny = (int)$db->query("SELECT COUNT(*) FROM information_schema.TABLES WHERE TABLE_SCHEMA = DATABASE()" )->fetchColumn() > 0;

        if ($hasAny && $overwrite) {
            dropAllTables($db);
        }

        // always (re)apply schema; schema.sql already drops tables if they exist
        $schemaPath = dirname(__DIR__) . '/scripts/schema.sql';
        applySqlFile($db, $schemaPath);

        // seed baseline company/store/admin
        $db->beginTransaction();

        // company
        $companyId = (int)$db->query('SELECT id FROM companies ORDER BY id LIMIT 1')->fetchColumn();
        if ($companyId === 0) {
            $st = $db->prepare('INSERT INTO companies (name) VALUES (?)');
            $st->execute([$companyName !== '' ? $companyName : 'Main Company']);
            $companyId = (int)$db->lastInsertId();
        }

        // store
        $storeId = (int)$db->query('SELECT id FROM stores ORDER BY id LIMIT 1')->fetchColumn();
        if ($storeId === 0) {
            $st = $db->prepare('INSERT INTO stores (name, company_id) VALUES (?, ?)');
            $st->execute([$storeName !== '' ? $storeName : 'Main Store', $companyId]);
            $storeId = (int)$db->lastInsertId();
        }

        // admin (required on fresh install)
        $users = (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn();
        if ($users === 0) {
            if ($adminName === '' || $adminUsername === '' || $adminPass === '') {
                throw new RuntimeException('Admin account details are required for a fresh install.');
            }
            $usernameHashColumns = [];
            foreach (['usernameHash', 'username_hash'] as $columnName) {
                $column = $db->query("SHOW COLUMNS FROM users LIKE '" . $columnName . "'")->fetch(PDO::FETCH_ASSOC);
                if ($column !== false) {
                    $usernameHashColumns[] = $columnName;
                }
            }
            if ($usernameHashColumns === []) {
                throw new RuntimeException(
                    'users table is missing a username hash column. Run the database upgrade scripts before continuing.'
                );
            }

            $columns       = array_merge(['username'], $usernameHashColumns, ['password_hash', 'home_store_id', 'company_id']);
            $placeholders  = array_fill(0, count($columns), '?');
            $usernameHashValue = usernameHash($adminUsername);
            $params        = [encryptField($adminUsername)];
            foreach ($usernameHashColumns as $columnName) {
                $params[] = $usernameHashValue;
            }
            $params[] = password_hash($adminPass, PASSWORD_DEFAULT);
            $params[] = $storeId;
            $params[] = $companyId;

            $sql = 'INSERT INTO users (' . implode(', ', $columns) . ') VALUES (' . implode(', ', $placeholders) . ')';
            $db->prepare($sql)->execute($params);

            $adminId = (int)$db->lastInsertId();

            $adminCol = $db->query("SHOW COLUMNS FROM staff LIKE 'is_admin'")->fetch()
                ? 'is_admin'
                : 'isAdmin';
            $db->prepare("INSERT INTO staff (id, name, {$adminCol}, store_id, company_id)"
                          . ' VALUES (?,?,?,?,?)')
               ->execute([$adminId, encryptField($adminName), 1, $storeId, $companyId]);

            $db->prepare(
                'INSERT INTO user_company_roles (user_id, company_id, role) VALUES (?, ?, ?)'
            )->execute([$adminId, $companyId, 'super_admin']);

            $db->prepare(
                'INSERT INTO user_store_roles (user_id, store_id, role) VALUES (?, ?, ?)'
            )->execute([$adminId, $storeId, 'store']);
        }

        $db->commit();

        // generate environment file with secrets
        $envPath    = dirname(__DIR__) . '/.env';
        $envLines   = [
            "DB_HOST={$host}",
            "DB_NAME={$dbname}",
            "DB_USER={$user}",
            "DB_PASS={$pass}",
            "JWT_SECRET={$jwtSecret}",
            "APP_KEY={$appKey}",
            "BACKUP_DIR={$backupDir}",
        ];
        $envContent = implode(PHP_EOL, $envLines) . PHP_EOL;
        if (file_put_contents($envPath, $envContent) === false) {
            throw new RuntimeException('Unable to write .env');
        }

        $parsedEnv = parse_ini_file($envPath, false, INI_SCANNER_RAW) ?: [];
        $requiredEnv = [
            'DB_HOST',
            'DB_NAME',
            'DB_USER',
            'DB_PASS',
            'JWT_SECRET',
            'APP_KEY',
            'BACKUP_DIR',
        ];
        $missing = [];
        foreach ($requiredEnv as $var) {
            if (($parsedEnv[$var] ?? '') === '') {
                $missing[] = $var;
            }
        }
        if ($missing) {
            $debugLines = [];
            foreach ($parsedEnv as $k => $v) {
                $debugLines[] = $k . '=' . $v;
            }
            throw new RuntimeException(
                '.env validation failed; missing: ' . implode(', ', $missing) . "\n" .
                'Current contents:' . PHP_EOL . implode(PHP_EOL, $debugLines)
            );
        }
        $envDebugPath = realpath($envPath) ?: $envPath;

        // ensure config.php exists for runtime
        $configPath = dirname(__DIR__) . '/config.php';
        $configTemplate = <<<'PHP'
<?php

$envFile = __DIR__ . '/.env';
if (is_readable($envFile)) {
    $vars = parse_ini_file($envFile, false, INI_SCANNER_RAW);
    if (is_array($vars)) {
        foreach ($vars as $key => $value) {
            if (!isset($_ENV[$key]) && getenv($key) === false) {
                $_ENV[$key] = $value;
                putenv($key . '=' . $value);
            }
        }
    }
}

return [
    'host' => $_ENV['DB_HOST'] ?? getenv('DB_HOST'),
    'user' => $_ENV['DB_USER'] ?? getenv('DB_USER'),
    'pass' => $_ENV['DB_PASS'] ?? getenv('DB_PASS'),
    'dbname' => $_ENV['DB_NAME'] ?? getenv('DB_NAME'),
    'jwt_secret' => $_ENV['JWT_SECRET'] ?? getenv('JWT_SECRET'),
    'app_key' => $_ENV['APP_KEY'] ?? getenv('APP_KEY'),
    'debug' => [
        'enabled' => filter_var($_ENV['DEBUG'] ?? getenv('DEBUG') ?? false, FILTER_VALIDATE_BOOLEAN),
        'allowed_ips' => array_values(array_filter(array_map('trim', explode(',', $_ENV['DEBUG_ALLOWED_IPS'] ?? getenv('DEBUG_ALLOWED_IPS') ?? '')))),
    ],
];
PHP;
        if (file_put_contents($configPath, $configTemplate) === false) {
            throw new RuntimeException('Unable to write config.php');
        }

        // stats for the success page
        $stats = [
            'stores' => (int)$db->query('SELECT COUNT(*) FROM stores')->fetchColumn(),
            'users'  => (int)$db->query('SELECT COUNT(*) FROM users')->fetchColumn(),
            'staff'  => (int)$db->query('SELECT COUNT(*) FROM staff')->fetchColumn(),
            'shifts' => (int)$db->query('SELECT COUNT(*) FROM shifts')->fetchColumn(),
            'chores' => (int)$db->query('SELECT COUNT(*) FROM chores')->fetchColumn(),
            'env_path' => $envDebugPath,
            'backup_dir' => $backupDir,
        ];
        $installed = true;

    } catch (Throwable $e) {
        $error = $e->getMessage();
    }
}
?>
<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Scheduler Setup</title>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="container py-5">
  <h1 class="mb-4">Scheduler Setup</h1>

  <?php if ($installed): ?>
    <div class="alert alert-success">Setup complete.</div>
    <ul>
      <li>.env: <?= htmlspecialchars($stats['env_path']) ?></li>
      <li>Backup dir: <?= htmlspecialchars((string)$stats['backup_dir']) ?></li>
      <li>Stores: <?= htmlspecialchars((string)$stats['stores']) ?></li>
      <li>Users: <?= htmlspecialchars((string)$stats['users']) ?></li>
      <li>Staff: <?= htmlspecialchars((string)$stats['staff']) ?></li>
      <li>Shifts: <?= htmlspecialchars((string)$stats['shifts']) ?></li>
      <li>Chores: <?= htmlspecialchars((string)$stats['chores']) ?></li>
    </ul>
    <a class="btn btn-primary" href="index.php">Go to app</a>
  <?php else: ?>
    <?php if ($error): ?>
      <div class="alert alert-danger"><?= htmlspecialchars($error, ENT_QUOTES) ?></div>
    <?php endif; ?>

    <form method="post" class="row g-3">
      <div class="col-md-6">
        <label class="form-label">MySQL Host</label>
        <input type="text" name="host" class="form-control" value="<?= htmlspecialchars($_POST['host'] ?? 'localhost', ENT_QUOTES) ?>" required>
      </div>
      <div class="col-md-6">
        <label class="form-label">Database</label>
        <input type="text" name="dbname" class="form-control" value="<?= htmlspecialchars($_POST['dbname'] ?? 'schedule_db', ENT_QUOTES) ?>" required>
      </div>
      <div class="col-md-6">
        <label class="form-label">User</label>
        <input type="text" name="user" class="form-control" value="<?= htmlspecialchars($_POST['user'] ?? '', ENT_QUOTES) ?>" required>
      </div>
      <div class="col-md-6">
        <label class="form-label">Password</label>
        <input type="password" name="pass" class="form-control" value="<?= htmlspecialchars($_POST['pass'] ?? '', ENT_QUOTES) ?>">
      </div>
      <div class="col-md-6">
        <label class="form-label">Company Name</label>
        <input type="text" name="company_name" class="form-control" value="<?= htmlspecialchars($_POST['company_name'] ?? '', ENT_QUOTES) ?>">
      </div>
      <div class="col-md-6">
        <label class="form-label">Store Name</label>
        <input type="text" name="store_name" class="form-control" value="<?= htmlspecialchars($_POST['store_name'] ?? '', ENT_QUOTES) ?>">
      </div>

      <hr class="mt-4">

      <div class="col-md-4">
        <label class="form-label">Admin Name</label>
        <input type="text" name="admin_name" class="form-control" value="<?= htmlspecialchars($_POST['admin_name'] ?? '', ENT_QUOTES) ?>">
      </div>
      <div class="col-md-4">
        <label class="form-label">Admin Username</label>
        <input type="text" name="admin_username" class="form-control" value="<?= htmlspecialchars($_POST['admin_username'] ?? '', ENT_QUOTES) ?>">
      </div>
      <div class="col-md-4">
        <label class="form-label">Admin Password</label>
        <input type="password" name="admin_pass" class="form-control" value="<?= htmlspecialchars($_POST['admin_pass'] ?? '', ENT_QUOTES) ?>">
      </div>

      <div class="col-12 form-check mt-3">
        <input class="form-check-input" type="checkbox" id="overwrite" name="overwrite" value="1" <?= isset($_POST['overwrite']) ? 'checked' : '' ?>>
        <label class="form-check-label" for="overwrite">Overwrite existing data (drop all tables first)</label>
      </div>

      <div class="col-12">
        <button type="submit" class="btn btn-danger">Install</button>
      </div>
    </form>
  <?php endif; ?>
</body>
</html>
