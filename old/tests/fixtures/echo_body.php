<?php
declare(strict_types=1);
require_once __DIR__ . '/../../src/data/core.php';
header('Content-Type: application/json');
$payload = read_json_body();
echo json_encode($payload);
