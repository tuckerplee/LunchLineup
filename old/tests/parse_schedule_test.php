<?php
declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

putenv('APP_KEY=' . base64_encode(str_repeat('a', 32)));
$_ENV['APP_KEY'] = base64_encode(str_repeat('a', 32));

$db  = create_test_db();
$ids = seed_sample_data($db);

function getDb(): PDO { global $db; return $db; }
function sanitizeString(string $v): string { return $v; }
require __DIR__ . '/util/db_table_has_column.php';
function jsonError(string $m, int $c): void { http_response_code($c); echo json_encode(['status'=>'error','message'=>$m,'code'=>$c]); }

require __DIR__ . '/../src/data/staff.php';
require __DIR__ . '/../src/schedule_parser.php';

function assert_eq($expected, $actual, string $msg = ''): void {
    if ($expected !== $actual) {
        echo "Assertion failed: $msg\n";
        var_export($actual);
        echo "\n";
        exit(1);
    }
}

// Plain text snippet
$plain = "Sunday 05/12/2024\nCashier\nSmith, Alice\n9:00 AM - 5:00 PM\n";
$resultPlain = parse_schedule_text($plain, $ids['company_id']);
assert_eq('ok', $resultPlain['status'], 'plain status');
assert_eq('Alice', $resultPlain['schedule']['2024-05-12']['employees'][0]['name'], 'plain name');
assert_eq('9:00 AM-5:00 PM', $resultPlain['schedule']['2024-05-12']['employees'][0]['shift'], 'plain shift');

// PDF-converted text snippet
$pdf = "Sun  Mon  Tue  Wed  Thu  Fri  Sat\n" .
       "05/12  05/13  05/14  05/15  05/16  05/17  05/18\n" .
       "Cashier  Cashier  Cashier  Cashier  Cashier  Cashier  Cashier\n" .
       "Smith, Alice  Smith, Alice  Smith, Alice  Smith, Alice  Smith, Alice  Smith, Alice  Smith, Alice\n" .
       "9:00 AM-5:00 PM  9:00 AM-5:00 PM  9:00 AM-5:00 PM  9:00 AM-5:00 PM  9:00 AM-5:00 PM  9:00 AM-5:00 PM  9:00 AM-5:00 PM\n";
$resultPdf = parse_schedule_text($pdf, $ids['company_id']);
assert_eq('ok', $resultPdf['status'], 'pdf status');
$firstDate = array_key_first($resultPdf['schedule']);
assert_eq('Alice', $resultPdf['schedule'][$firstDate]['employees'][0]['name'], 'pdf name');

if (!function_exists('requestParam')) {
    function requestParam(string $key, mixed $default = null): mixed {
        return $_POST[$key] ?? $_GET[$key] ?? $default;
    }
}
if (!function_exists('verify_api_token')) {
    function verify_api_token(?string $token) { return ['sub' => 1, 'company_id' => 1, 'companies' => [1]]; }
}
if (!function_exists('is_debug_allowed')) {
    function is_debug_allowed($auth): bool { return true; }
}

function run_api(array $server, array $get, array $post, string $body): array {
    $script = file_get_contents(__DIR__ . '/../public/api/parse_schedule.php');
    $script = preg_replace("/require_once __DIR__ . '\/\.\.\/\.\.\/src\/data.php';/", '', $script);
    $script = preg_replace("/require_once __DIR__ . '\/\.\.\/\.\.\/src\/schedule_parser.php';/", '', $script);
    $script = str_replace("file_get_contents('php://input')", '$_RAW_BODY', $script);
    $script = str_replace('exit;', 'return;', $script);
    $script = str_replace('header(', 'header_capture(', $script);
    $script = str_replace('jsonError(', 'return jsonError(', $script);

    $_SERVER = $server;
    $_GET    = $get;
    $_POST   = $post;
    $_RAW_BODY = $body;
    http_response_code(200);

    $GLOBALS['captured_headers'] = [];
    if (!function_exists('header_capture')) {
        function header_capture($string): void {
            $GLOBALS['captured_headers'][] = $string;
        }
    }
    ob_start();
    eval('?>' . $script);
    $output = ob_get_clean();
    $code   = http_response_code();
    $headers = $GLOBALS['captured_headers'];
    $GLOBALS['captured_headers'] = [];
    return [$code, $headers, $output];
}

// API tests: empty body
[$code, $hdrs, $out] = run_api(
    ['REQUEST_METHOD' => 'GET'],
    ['debug' => '', 'mode' => 'json', 'company_id' => $ids['company_id']],
    [],
    ''
);
assert_eq(400, $code, 'empty body code');
$body = json_decode($out, true);
assert_eq('Missing or empty body', $body['message'] ?? '', 'empty body message');
assert_eq(400, $body['code'] ?? 0, 'empty body code field');

// API tests: missing staff
$db->exec('DELETE FROM staff');
[$code, $hdrs, $out] = run_api(
    ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'text/plain'],
    ['debug' => 1, 'mode' => 'json', 'company_id' => $ids['company_id']],
    [],
    $plain
);
assert_eq(400, $code, 'no staff code');
$body = json_decode($out, true);
assert_eq('No staff found', $body['message'] ?? '', 'no staff message');
assert_eq(400, $body['code'] ?? 0, 'no staff code field');

// API tests: success path
$db->exec("INSERT INTO staff (store_id, company_id, name, lunch_duration, isAdmin) VALUES (1, 1, 'Alice', 30, 0)");
[$code, $hdrs, $out] = run_api(
    ['REQUEST_METHOD' => 'POST', 'CONTENT_TYPE' => 'text/plain'],
    ['debug' => 1, 'mode' => 'json', 'company_id' => $ids['company_id']],
    [],
    $plain
);
assert_eq(200, $code, 'success code');
$ct = '';
foreach ($hdrs as $h) {
    if (stripos($h, 'Content-Type:') === 0) {
        $ct = trim(substr($h, strlen('Content-Type:')));
    }
}
assert_eq('application/json', $ct, 'content type');
assert_eq('ok', json_decode($out, true)['status'] ?? '', 'success status');

teardown_test_db($db);

echo "parse schedule tests passed\n";
