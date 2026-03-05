<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();
$db->exec('CREATE TABLE login_attempts (
    user_id INTEGER NOT NULL,
    ip TEXT NOT NULL,
    attempts INTEGER NOT NULL,
    last_attempt TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, ip)
)');

$ids = seed_sample_data($db);
$hash = password_hash('secret', PASSWORD_DEFAULT);
$db->prepare('UPDATE users SET password_hash = ? WHERE id = ?')->execute([$hash, $ids['user_id']]);

function getDb(): PDO { global $db; return $db; }
function decryptField(string $v): string { return $v; }
function emailHash(string $email): string { return hash('sha256', strtolower($email)); }
function getUserEmailHashColumn(): string { return 'emailHash'; }
function getUserEmailHashColumns(): array { return ['emailHash']; }
function read_json_body(): array { global $_RAW_BODY; return json_decode($_RAW_BODY, true) ?? []; }
function jsonError(string $m, int $c): void { http_response_code($c); echo json_encode(['status'=>'error','message'=>$m,'code'=>$c]); }

function header_capture(string $h): void { $GLOBALS['captured_headers'][] = $h; }
function setcookie_capture(): void { /* no-op */ }

function run_api(array $server, string $body): array {
    static $runner = null;
    if ($runner === null) {
        $script = file_get_contents(__DIR__ . '/../public/api/auth.php');
        $script = preg_replace('/^<\?php\s*/', '', $script);
        $script = preg_replace("/require_once __DIR__ . '\/\.\.\/\.\.\/src\/data.php';\n/", '', $script);
        $script = str_replace(
            "'UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?'",
            "\"UPDATE users SET locked_until = DATETIME('now', '+15 minutes') WHERE id = ?\"",
            $script
        );
        $script = str_replace('NOW()', 'CURRENT_TIMESTAMP', $script);
        $script = str_replace('ON DUPLICATE KEY UPDATE attempts = attempts + 1, last_attempt = CURRENT_TIMESTAMP',
            'ON CONFLICT(user_id, ip) DO UPDATE SET attempts = attempts + 1, last_attempt = CURRENT_TIMESTAMP', $script);
        $script = str_replace('jsonError(', 'return jsonError(', $script);
        $script = preg_replace(
            '/function issueToken[\s\S]*?\nif \(\$method ===/',
            "if (!function_exists('issueToken')) { function issueToken(int \$userId): array { return ['status' => 'ok']; } }\n\nif (\$method ===",
            $script,
            1
        );
        $script = str_replace('exit;', 'return;', $script);
        $script = str_replace('header(', 'header_capture(', $script);
        $script = str_replace('setcookie(', 'setcookie_capture(', $script);
        $runner = eval('return function() {' . $script . '};');
    }
    $_SERVER = $server;
    global $_RAW_BODY;
    $_RAW_BODY = $body;
    $GLOBALS['captured_headers'] = [];
    http_response_code(200);
    ob_start();
    $runner();
    $output = ob_get_clean();
    $code = http_response_code();
    return [$code, $GLOBALS['captured_headers'], $output];
}

function run_auth(string $email, string $password): int {
    [$code] = run_api(
        [
            'REQUEST_METHOD' => 'POST',
            'REMOTE_ADDR'    => '127.0.0.1',
            'CONTENT_TYPE'   => 'application/json'
        ],
        json_encode(['email' => $email, 'password' => $password])
    );
    return $code;
}

function assert_eq(int $expected, int $actual, string $msg): void {
    if ($expected !== $actual) {
        echo $msg . "\n";
        exit(1);
    }
}

try {
    for ($i = 1; $i <= 4; $i++) {
        assert_eq(401, run_auth('user@example.com', 'wrong'), "attempt $i should be 401");
    }
    assert_eq(423, run_auth('user@example.com', 'wrong'), 'fifth attempt should lock');

    $db->exec("UPDATE users SET locked_until = DATETIME('now', '-1 minute') WHERE id = {$ids['user_id']}");

    assert_eq(200, run_auth('user@example.com', 'secret'), 'login should succeed after lockout period');
    assert_eq(401, run_auth('user@example.com', 'wrong'), 'failed attempt after success should reset counter');
} finally {
    teardown_test_db($db);
}

echo "login lockout tests passed\n";
