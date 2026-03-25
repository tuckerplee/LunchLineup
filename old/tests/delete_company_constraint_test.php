<?php

declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();

function getDb(): PDO
{
    global $db;
    return $db;
}

function sanitizeString(string $value): string
{
    return htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
}

function auditLog(string $action, string $entity, ?int $entityId = null, ?int $companyId = null): void
{
}

require __DIR__ . '/../src/data/stores.php';

try {
    $ids    = seed_sample_data($db);
    $result = deleteCompany($ids['company_id']);
    if ($result !== false) {
        echo "deleteCompany should fail when dependent records exist\n";
        exit(1);
    }
    $count = (int) $db
        ->query('SELECT COUNT(*) FROM companies WHERE id = ' . $ids['company_id'])
        ->fetchColumn();
    if ($count !== 1) {
        echo "Company should not be deleted when dependent records exist\n";
        exit(1);
    }
} finally {
    teardown_test_db($db);
}

echo "Company deletion constraint test passed\n";
