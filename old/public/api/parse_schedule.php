<?php
require_once __DIR__ . '/../../src/data.php';

$maxSize = 5 * 1024 * 1024; // 5 MB limit

if (!function_exists('convert_pdf_to_text')) {
    function convert_pdf_to_text(string $path): array
    {
        $binary = trim(shell_exec('which pdftotext 2>/dev/null') ?? '');
        if ($binary === '') {
            return [null, 'pdftotext not installed'];
        }

        $cmd      = escapeshellcmd($binary) . ' -layout -nopgbrk ' . escapeshellarg($path) . ' - 2>&1';
        $output   = [];
        $exitCode = 0;
        exec($cmd, $output, $exitCode);
        if ($exitCode !== 0) {
            $error = trim(implode("\n", $output));
            return [null, $error !== '' ? $error : 'pdftotext failed'];
        }

        return [implode("\n", $output), null];
    }
}

$method        = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$mode          = $_GET['mode'] ?? $_POST['mode'] ?? null; // 'json' to force JSON on GET
$token         = requestParam('token');
$auth          = verify_api_token($token);
$debugRequested = isset($_GET['debug']) || isset($_POST['debug']);
if ($debugRequested && !is_debug_allowed($auth)) {
    jsonError('Debug disabled', 403);
}
$isDebug    = $debugRequested;
$debugValue = $_GET['debug'] ?? $_POST['debug'] ?? null;
$companyId  = (int) requestParam(
    'company_id',
    $auth['company_id'] ?? (count($auth['companies'] ?? []) === 1 ? (int) $auth['companies'][0] : 0)
);
if (!$isDebug && $companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!$isDebug && !in_array($companyId, $auth['companies'] ?? [], true)) {
    jsonError('Forbidden', 403);
}

/**
 * Always render the HTML form on GET when ?debug is present,
 * unless mode=json (lets you GET JSON if you want).
 */
if ($isDebug && $method === 'GET' && $mode !== 'json') {
    header('Content-Type: text/html; charset=utf-8');
    $self = htmlspecialchars($_SERVER['PHP_SELF'], ENT_QUOTES, 'UTF-8');
    ?>
<!DOCTYPE html>
<html>
<body>
  <h3>Schedule Parser Debug</h3>
  <form method="post" enctype="multipart/form-data" action="<?php echo $self; ?>?debug=1&mode=json">
    <p><input type="file" name="file" accept=".pdf,.txt"></p>
    <p><textarea name="text" rows="12" cols="80" placeholder="Or paste text here"></textarea></p>
    <p><button type="submit">Parse</button></p>
  </form>
  <p>
    <a href="<?php echo $self; ?>?debug=1&mode=json">GET JSON instead</a>
  </p>
</body>
</html>
    <?php
    exit;
}

header('Content-Type: application/json');

/** Allow:
 *  - POST (prod or debug)
 *  - GET + ?debug=1&mode=json (debug JSON)
 */
if ($method !== 'POST' && !($isDebug && $method === 'GET' && $mode === 'json')) {
    jsonError('Method not allowed', 405);
}

// API token check only when not debugging
if (!$isDebug && $auth === false) {
    jsonError('Invalid token', 403);
}

// Acquire raw text
$raw = null;

// 1) multipart/form-data file upload (works for both prod and debug)
if ($method === 'POST' && !empty($_FILES['file']) && ($_FILES['file']['error'] ?? UPLOAD_ERR_NO_FILE) === UPLOAD_ERR_OK) {
    if (($_FILES['file']['size'] ?? 0) > $maxSize) {
        jsonError('File exceeds 5 MB limit', 413);
    }

    $tmp  = $_FILES['file']['tmp_name'];
    $name = strtolower($_FILES['file']['name']);
    if (substr($name, -4) === '.pdf') {
        // preserve columns/headings; avoid page-break inserts
        [$raw, $err] = convert_pdf_to_text($tmp);
        if ($err !== null) {
            jsonError($err, 500);
        }
    } else {
        $raw = file_get_contents($tmp);
    }

// 2) raw PDF in body (application/pdf)
} elseif ($method === 'POST' && stripos($_SERVER['CONTENT_TYPE'] ?? '', 'application/pdf') !== false) {
    $data = file_get_contents('php://input') ?: '';
    if (strlen($data) > $maxSize) {
        jsonError('File exceeds 5 MB limit', 413);
    }

    $tmp = tempnam(sys_get_temp_dir(), 'pdf');
    file_put_contents($tmp, $data);
    [$raw, $err] = convert_pdf_to_text($tmp);
    unlink($tmp);
    if ($err !== null) {
        jsonError($err, 500);
    }

// 3) plain text in body (text/plain)
} elseif ($method === 'POST' && stripos($_SERVER['CONTENT_TYPE'] ?? '', 'text/plain') !== false) {
    $raw = file_get_contents('php://input') ?: '';
    if (strlen($raw) > $maxSize) {
        jsonError('Body exceeds 5 MB limit', 413);
    }

// 4) debug textarea paste on POST
} elseif ($isDebug && $method === 'POST') {
    $raw = $_POST['text'] ?? '';
    if (strlen($raw) > $maxSize) {
        jsonError('Body exceeds 5 MB limit', 413);
    }

// 5) debug GET JSON (optional support for ?text=…)
} elseif ($isDebug && $method === 'GET' && $mode === 'json') {
    $raw = $_GET['text'] ?? $debugValue ?? '';
    if (strlen($raw) > $maxSize) {
        jsonError('Body exceeds 5 MB limit', 413);
    }
}

if ($raw === null || trim($raw) === '') {
    jsonError('Missing or empty body', 400);
}

$staffRows = fetchStaff(null, $companyId, false);
if (!$staffRows) {
    jsonError('No staff found', 400);
}

require_once __DIR__ . '/../../src/schedule_parser.php';

$result = parse_schedule_text($raw, $companyId, null, $isDebug && $mode === 'json');

echo json_encode($result);
