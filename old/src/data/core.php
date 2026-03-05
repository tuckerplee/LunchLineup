<?php
declare(strict_types=1);

// Shared utilities and database helpers

function getConfig(): array
{
    static $config = null;
    if ($config === null) {
        $configFile = __DIR__ . '/../../config.php';
        if (!file_exists($configFile)) {
            exit("Missing config.php. Visit setup.php in your browser to create one.\n");
        }
        $config = require $configFile;
    }
    return $config;
}

function getDb(): PDO
{
    static $db = null;
    if ($db instanceof PDO) {
        return $db;
    }
    $config = getConfig();
    $dsn = 'mysql:host=' . $config['host'] . ';dbname=' . $config['dbname'] . ';charset=utf8mb4';
    $db = new PDO($dsn, $config['user'], $config['pass']);
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    return $db;
}

function initDb(): void
{
    $db = getDb();
    $schema = __DIR__ . '/../../scripts/schema.sql';
    if (file_exists($schema)) {
        $sql = file_get_contents($schema);
        $statements = array_filter(array_map('trim', explode(';', $sql)));
        foreach ($statements as $statement) {
            $db->exec($statement);
        }
    }
}

function set_audit_user(int $userId): void
{
    $GLOBALS['audit_user_id'] = $userId;
}

function set_audit_company(int $companyId): void
{
    $GLOBALS['audit_company_id'] = $companyId;
}

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function jsonError(string $message, int $code): never
{
    http_response_code($code);
    header('Content-Type: application/json');
    echo json_encode([
        'status'  => 'error',
        'message' => $message,
        'code'    => $code,
    ]);
    exit;
}

function requestParam(string $key, mixed $default = null): mixed
{
    if (array_key_exists($key, $_POST)) {
        $value = $_POST[$key];
    } elseif (array_key_exists($key, $_GET)) {
        $value = $_GET[$key];
    } else {
        $legacyKey = preg_replace_callback(
            '/_([a-z])/',
            fn ($m) => strtoupper($m[1]),
            $key
        );
        if ($legacyKey !== $key && (isset($_POST[$legacyKey]) || isset($_GET[$legacyKey]))) {
            header('X-Deprecation-Warning: Use ' . $key . ' instead of ' . $legacyKey);
            $value = $_POST[$legacyKey] ?? $_GET[$legacyKey];
        } else {
            $value = $default;
        }
    }
    return is_array($value) ? $default : $value;
}

function read_json_body(): mixed
{
    $contentType = $_SERVER['CONTENT_TYPE'] ?? '';
    if (stripos($contentType, 'application/json') !== 0) {
        jsonError('Expected application/json', 400);
    }
    $raw = file_get_contents('php://input');
    if ($raw === '' || $raw === false) {
        return [];
    }
    $data = json_decode($raw, true);
    if (json_last_error() !== JSON_ERROR_NONE) {
        jsonError('Invalid JSON', 400);
    }
    return $data;
}

function generate_csrf_token(): string
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_start();
    }
    if (empty($_SESSION['csrf_token'])) {
        $_SESSION['csrf_token'] = bin2hex(random_bytes(32));
    }
    return (string) $_SESSION['csrf_token'];
}

function validate_csrf_token(?string $token): bool
{
    if (session_status() !== PHP_SESSION_ACTIVE) {
        session_start();
    }
    if (!isset($_SESSION['csrf_token'])) {
        return false;
    }
    return is_string($token) && hash_equals($_SESSION['csrf_token'], $token);
}

function require_csrf_token(): void
{
    $method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
    if (!in_array($method, ['POST', 'PUT', 'DELETE'], true)) {
        return;
    }
    if (isset($_GET['token']) || isset($_POST['token']) || isset($_SERVER['HTTP_AUTHORIZATION'])) {
        return;
    }
    $token = requestParam('csrf_token', '');
    if (!validate_csrf_token($token)) {
        jsonError('Invalid CSRF token', 403);
    }
}

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    $db     = getDb();
    $userId = isset($GLOBALS['audit_user_id']) && (int) $GLOBALS['audit_user_id'] > 0
        ? (int) $GLOBALS['audit_user_id']
        : null;
    $companyId = $companyId
        ?? (isset($GLOBALS['audit_company_id']) && (int) $GLOBALS['audit_company_id'] > 0
            ? (int) $GLOBALS['audit_company_id']
            : 1);
    $stmt = $db->prepare('INSERT INTO audit_logs (user_id, company_id, action, entity, entity_id) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([$userId, $companyId, $action, $entity, $entityId]);
}

function is_debug_allowed(?array $auth): bool
{
    $config = getConfig();
    if (!($config['debug']['enabled'] ?? false)) {
        return false;
    }
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $allowed = $config['debug']['allowed_ips'] ?? [];
    if (in_array($ip, $allowed, true)) {
        return true;
    }
    if (is_array($auth) && isset($auth['sub']) && is_super_admin((int) $auth['sub'])) {
        return true;
    }
    return false;
}

function db_table_has_column(string $table, string $column): bool
{
    static $cache = [];
    $key = $table . '.' . $column;
    if (isset($cache[$key])) {
        return $cache[$key];
    }
    $db     = getDb();
    $config = getConfig();
    $stmt   = $db->prepare(
        'SELECT 1 FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND COLUMN_NAME = ?'
    );
    $stmt->execute([$config['dbname'], $table, $column]);
    $cache[$key] = $stmt->fetchColumn() !== false;
    return $cache[$key];
}
