<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../tests/run_suite.php';

header('Content-Type: application/json');

$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$token  = requestParam('token');
$auth   = verify_api_token($token);

if ($auth === false || empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    exit;
}

if ($method === 'POST') {
    set_time_limit(0);

    $filterParam = requestParam('filter');
    $filter = is_string($filterParam) && $filterParam !== '' ? $filterParam : null;

    $suite = runTestSuite($filter);

    $results = array_map(
        static function (array $result): array {
            return [
                'file'     => $result['name'],
                'exitCode' => $result['exitCode'],
                'stdout'   => $result['stdout'],
                'stderr'   => $result['stderr'],
                'message'  => $result['message'],
                'passed'   => $result['exitCode'] === 0,
            ];
        },
        $suite['results']
    );

    $status = 'ok';
    if ($suite['results'] === [] && $suite['message'] !== null) {
        $status = 'error';
    } elseif ($suite['exitCode'] !== 0) {
        $status = 'fail';
    } elseif ($suite['configRestored'] === false) {
        $status = 'fail';
    }

    echo json_encode([
        'status'         => $status,
        'exitCode'       => $suite['exitCode'],
        'results'        => $results,
        'summary'        => $suite['summary'],
        'configRestored' => $suite['configRestored'],
        'message'        => $suite['message'],
    ]);
    exit;
}

http_response_code(405);
echo json_encode(['status' => 'error', 'message' => 'Method not allowed']);
