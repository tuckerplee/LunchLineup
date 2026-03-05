<?php
require_once __DIR__ . '/../src/data.php';

function migrate_staff_company(): void
{
    initDb();
    $db = getDb();

    // Ensure store_id is nullable
    $db->exec('ALTER TABLE staff MODIFY store_id INT NULL');

    // Add company_id column if it does not exist
    $cols = $db->query("SHOW COLUMNS FROM staff LIKE 'company_id'")->fetchAll();
    if (count($cols) === 0) {
        $db->exec('ALTER TABLE staff ADD COLUMN company_id INT NULL');
        $db->exec('ALTER TABLE staff ADD KEY company_id (company_id)');
        $db->exec('ALTER TABLE staff ADD KEY store_id (store_id)');
        $db->exec('ALTER TABLE staff ADD CONSTRAINT fk_staff_company FOREIGN KEY (company_id) REFERENCES companies(id)');
    }

    // Populate company_id from associated store
    $db->exec('UPDATE staff s JOIN stores st ON s.store_id = st.id SET s.company_id = st.company_id WHERE s.company_id IS NULL');

    // Enforce NOT NULL
    $db->exec('ALTER TABLE staff MODIFY company_id INT NOT NULL');
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    migrate_staff_company();
    echo "Staff company migration complete\n";
}
