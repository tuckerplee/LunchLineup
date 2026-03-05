<?php
declare(strict_types=1);

$docroot = __DIR__ . '/fixtures';
$cmd = sprintf('php -S 127.0.0.1:8085 -t %s', escapeshellarg($docroot));
$proc = proc_open($cmd, [], $pipes);
if (!is_resource($proc)) {
    echo "Failed to start server\n";
    exit(1);
}
// give the server a moment to start
usleep(500000);

$context = stream_context_create([
    'http' => [
        'method'        => 'POST',
        'header'        => "Content-Type: application/json\r\n",
        'content'       => '{invalid',
        'ignore_errors' => true,
    ],
]);

file_get_contents('http://127.0.0.1:8085/echo_body.php', false, $context);
$statusLine = $http_response_header[0] ?? '';
proc_terminate($proc);
proc_close($proc);

if (strpos($statusLine, '400') === false) {
    echo "Expected 400, got $statusLine\n";
    exit(1);
}

echo "invalid JSON test passed\n";
