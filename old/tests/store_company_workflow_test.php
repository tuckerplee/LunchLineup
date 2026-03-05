<?php

declare(strict_types=1);

require __DIR__ . '/util/test_db.php';

$db = create_test_db();
$db->exec(
    'CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        company_id INTEGER NOT NULL,
        action TEXT NOT NULL,
        entity TEXT NOT NULL,
        entity_id INTEGER,
        created_at TEXT DEFAULT CURRENT_TIMESTAMP
    )'
);

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
    $db = getDb();
    $stmt = $db->prepare(
        'INSERT INTO audit_logs (user_id, company_id, action, entity, entity_id) VALUES (NULL, ?, ?, ?, ?)'
    );
    $stmt->execute([$companyId ?? 1, $action, $entity, $entityId]);
}

require __DIR__ . '/../src/data/stores.php';

function assert_true(bool $condition, string $message): void
{
    if (! $condition) {
        echo $message . "\n";
        exit(1);
    }
}

function assert_same(mixed $expected, mixed $actual, string $message): void
{
    if ($expected !== $actual) {
        echo $message . "\n";
        exit(1);
    }
}

try {
    // Company workflow
    $companyId = saveCompany(['name' => 'Acme']);
    $companies = fetchCompanies();
    assert_true(in_array($companyId, array_column($companies, 'id')), 'Company not retrievable');

    saveCompany(['id' => $companyId, 'name' => 'Acme Updated']);
    $companies = fetchCompanies();
    $company = array_values(array_filter($companies, fn ($c) => (int) $c['id'] === $companyId))[0];
    assert_same('Acme Updated', $company['name'], 'Company update failed');

    $count = (int) $db->query(
        "SELECT COUNT(*) FROM audit_logs WHERE entity = 'company' AND entity_id = $companyId AND action = 'save'"
    )->fetchColumn();
    assert_same(2, $count, 'Company save not logged');

    deleteCompany($companyId);
    $companies = fetchCompanies();
    assert_true(! in_array($companyId, array_column($companies, 'id')), 'Company not deleted');
    $count = (int) $db->query(
        "SELECT COUNT(*) FROM audit_logs WHERE entity = 'company' AND entity_id = $companyId AND action = 'delete'"
    )->fetchColumn();
    assert_same(1, $count, 'Company delete not logged');

    // Store workflow
    $companyId = saveCompany(['name' => 'StoreCo']);
    $storeId = saveStore(['name' => 'Main', 'location' => 'NY'], $companyId);
    $stores = fetchStores($companyId);
    assert_true(in_array($storeId, array_column($stores, 'id')), 'Store not retrievable');

    saveStore(['id' => $storeId, 'name' => 'Main Updated', 'location' => 'LA'], $companyId);
    $stores = fetchStores($companyId);
    $store = array_values(array_filter($stores, fn ($s) => (int) $s['id'] === $storeId))[0];
    assert_same('Main Updated', $store['name'], 'Store name update failed');
    assert_same('LA', $store['location'], 'Store location update failed');

    $count = (int) $db->query(
        "SELECT COUNT(*) FROM audit_logs WHERE entity = 'store' AND entity_id = $storeId AND action = 'save'"
    )->fetchColumn();
    assert_same(2, $count, 'Store save not logged');

    deleteStore($storeId);
    $stores = fetchStores($companyId);
    assert_true(! in_array($storeId, array_column($stores, 'id')), 'Store not deleted');
    $count = (int) $db->query(
        "SELECT COUNT(*) FROM audit_logs WHERE entity = 'store' AND entity_id = $storeId AND action = 'delete'"
    )->fetchColumn();
    assert_same(1, $count, 'Store delete not logged');

    deleteCompany($companyId);
} finally {
    teardown_test_db($db);
}

echo "Store/company workflow tests passed\n";
