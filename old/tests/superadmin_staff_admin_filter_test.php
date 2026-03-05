<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

$db = create_test_db();

function getDb(): PDO
{
    global $db;
    return $db;
}

require __DIR__ . '/util/db_table_has_column.php';

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
    // no-op
}

require_once __DIR__ . '/../src/crypto.php';
function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

require __DIR__ . '/../src/data/staff.php';

function requestParam(string $key, mixed $default = null): mixed
{
    return $_GET[$key] ?? $_POST[$key] ?? $default;
}

function verify_api_token(?string $token)
{
    return ['sub' => 1, 'companies' => [1]];
}

function require_company_admin(array $auth, int $companyId): void
{
    // no-op
}

function require_csrf_token(): void
{
    // no-op
}

function set_audit_user(int $id): void
{
    // no-op
}

function set_audit_company(int $id): void
{
    // no-op
}

function header_capture(string $h): void
{
    $GLOBALS['captured_headers'][] = $h;
}

function run_staff_endpoint(array $params): array
{
    $script = file_get_contents(__DIR__ . '/../public/superadmin-api/staff.php');
    $script = preg_replace("/^<\\?php\\s*/", '', $script);
    $script = preg_replace("/require_once __DIR__ . '\\/..\/..\/src\/data.php';\\n/", '', $script);
    $script = preg_replace("/require_once __DIR__ . '\\/..\/..\/src\/auth.php';\\n/", '', $script);
    $script = str_replace("__DIR__ . '/../../src/StaffService.php'", "__DIR__ . '/../src/StaffService.php'", $script);
    $script = str_replace('exit;', 'return;', $script);
    $script = str_replace('header(', 'header_capture(', $script);
    $_SERVER = ['REQUEST_METHOD' => 'GET'];
    $_GET    = $params;
    http_response_code(200);
    $GLOBALS['captured_headers'] = [];
    ob_start();
    eval($script);
    $out  = ob_get_clean();
    $code = http_response_code();
    return [$code, $out];
}

function assert_same(mixed $expected, mixed $actual): void
{
    if ($expected !== $actual) {
        echo 'Assertion failed: expected ';
        var_export($expected);
        echo ', got ';
        var_export($actual);
        echo "\n";
        exit(1);
    }
}

try {
    $db->exec("INSERT INTO companies (name) VALUES ('Acme')");
    $companyId = (int) $db->lastInsertId();
    $db->exec("INSERT INTO stores (company_id, name) VALUES ($companyId, 'Main')");
    $storeId = (int) $db->lastInsertId();

    $stmt = $db->prepare('INSERT INTO staff (id, store_id, company_id, name, isAdmin) VALUES (?, ?, ?, ?, ?)');
    $stmt->execute([1, $storeId, $companyId, encryptField('Alice'), 0]);
    $stmt->execute([2, $storeId, $companyId, encryptField('Bob'), 1]);

    [, $out] = run_staff_endpoint([
        'token'      => 't',
        'company_id' => (string) $companyId,
    ]);
    $rows = json_decode($out, true);
    assert_same(1, count($rows));
    assert_same('Alice', $rows[0]['name']);

    [, $out] = run_staff_endpoint([
        'token'         => 't',
        'company_id'    => (string) $companyId,
        'includeAdmins' => 'true',
    ]);
    $rows  = json_decode($out, true);
    assert_same(2, count($rows));
    $names = array_column($rows, 'name');
    sort($names);
    assert_same(['Alice', 'Bob'], $names);
} finally {
    teardown_test_db($db);
}

echo "superadmin staff admin filter tests passed\n";
