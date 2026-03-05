<?php
require_once __DIR__ . '/../../src/data.php';
require_once __DIR__ . '/../../src/schedule_parser.php';

header('Content-Type: application/json; charset=utf-8');
if (($_SERVER['REQUEST_METHOD'] ?? 'GET') !== 'POST') {
    jsonError('Method not allowed', 405);
}

$debugRequested = isset($_GET['debug']) || isset($_POST['debug']);
$token          = requestParam('token');
$auth           = verify_api_token($token);
if ($debugRequested && !is_debug_allowed($auth)) {
    jsonError('Debug disabled', 403);
}
$debug = $debugRequested;
if (!$debug && $auth === false) {
    jsonError('Invalid token', 403);
}
$companyId = (int) requestParam('company_id',
    $auth['company_id'] ?? (count($auth['companies'] ?? []) === 1 ? (int) $auth['companies'][0] : 0)
);
$storeId = (int) requestParam('store_id', 0);
if (!$debug && $companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!$debug && !in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}
if (!$debug && $storeId === 0) {
    jsonError('Missing store_id', 400);
}
if (
    !$debug
    && (
        !in_array($storeId, $auth['stores'] ?? [], true)
        || get_store_company_id($storeId) !== $companyId
    )
) {
    jsonError('Forbidden', 403);
}

$upload = $_FILES['file'] ?? $_FILES['pdf'] ?? null;
if (!$upload || ($upload['error'] ?? UPLOAD_ERR_NO_FILE) !== UPLOAD_ERR_OK) {
    jsonError('Missing PDF upload', 400);
}

$maxFileSize = 5 * 1024 * 1024;
if (($upload['size'] ?? 0) > $maxFileSize) {
    jsonError('File too large', 400);
}
$finfo = new finfo(FILEINFO_MIME_TYPE);
$mime  = $finfo->file($upload['tmp_name']);
if ($mime !== 'application/pdf') {
    jsonError('Invalid file type', 400);
}

$pdftotext = trim(shell_exec('command -v pdftotext 2>/dev/null') ?? '');
if ($pdftotext === '') {
    jsonError('pdftotext not installed', 500);
}

$cmd  = 'LANG=C LC_ALL=C ' . escapeshellcmd($pdftotext) . ' -layout -nopgbrk -enc UTF-8 -eol unix ' . escapeshellarg($upload['tmp_name']) . ' - 2>&1';
$debug && error_log($cmd);
$text = shell_exec($cmd);
if ($text === null || trim($text) === '') {
    jsonError('Failed to convert PDF (empty output)', 500);
}

if (($_POST['mode'] ?? $_GET['mode'] ?? '') === 'text') {
    $resp = ['status' => 'ok', 'text' => $text];
    if ($debug) {
        $resp['debugPreview'] = substr($text, 0, 500);
    }
    echo json_encode($resp);
    exit;
}

$staffRows = fetchStaff($storeId ?: null, $companyId ?: null);
if (!$staffRows) {
    jsonError('No staff found', 400);
}

$result = parse_schedule_text($text, $companyId, $storeId, $debug);
http_response_code(($result['status'] ?? '') === 'ok' ? 200 : 422);
echo json_encode($result);
