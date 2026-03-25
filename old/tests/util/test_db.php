<?php

declare(strict_types=1);

/**
 * Test database utilities.
 */
function create_test_db(): PDO
{
    $db = new PDO('sqlite::memory:');
    $db->setAttribute(PDO::ATTR_ERRMODE, PDO::ERRMODE_EXCEPTION);
    $db->exec('PRAGMA foreign_keys = ON');

    $schema = [
        // companies
        'CREATE TABLE companies (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP
        )',
        // stores
        'CREATE TABLE stores (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            location TEXT,
            FOREIGN KEY (company_id) REFERENCES companies(id)
                ON UPDATE CASCADE ON DELETE RESTRICT
        )',
        // users
        'CREATE TABLE users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id INTEGER NOT NULL,
            email TEXT NOT NULL,
            emailHash TEXT NOT NULL UNIQUE,
            password_hash TEXT NOT NULL,
            locked_until TEXT,
            home_store_id INTEGER NOT NULL,
            created_at TEXT DEFAULT CURRENT_TIMESTAMP,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (company_id) REFERENCES companies(id)
                ON UPDATE CASCADE ON DELETE RESTRICT,
            FOREIGN KEY (home_store_id) REFERENCES stores(id)
                ON UPDATE CASCADE ON DELETE RESTRICT
        )',
        // roles
        'CREATE TABLE roles (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT NOT NULL UNIQUE
        )',
        // role_permissions
        'CREATE TABLE role_permissions (
            role_id INTEGER NOT NULL,
            permission TEXT NOT NULL,
            PRIMARY KEY (role_id, permission),
            FOREIGN KEY (role_id) REFERENCES roles(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        )',
        // user_company_roles
        'CREATE TABLE user_company_roles (
            user_id INTEGER NOT NULL,
            company_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (user_id, company_id, role),
            FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            FOREIGN KEY (company_id) REFERENCES companies(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        )',
        // user_store_roles
        'CREATE TABLE user_store_roles (
            user_id INTEGER NOT NULL,
            store_id INTEGER NOT NULL,
            role TEXT NOT NULL,
            PRIMARY KEY (user_id, store_id, role),
            FOREIGN KEY (user_id) REFERENCES users(id)
                ON UPDATE CASCADE ON DELETE CASCADE,
            FOREIGN KEY (store_id) REFERENCES stores(id)
                ON UPDATE CASCADE ON DELETE CASCADE
        )',
        // staff
        'CREATE TABLE staff (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            store_id INTEGER,
            company_id INTEGER NOT NULL,
            name TEXT NOT NULL,
            lunch_duration INTEGER DEFAULT 30,
            pos TEXT,
            tasks TEXT,
            isAdmin INTEGER DEFAULT 0,
            FOREIGN KEY (store_id) REFERENCES stores(id)
                ON UPDATE CASCADE ON DELETE SET NULL,
            FOREIGN KEY (company_id) REFERENCES companies(id)
                ON UPDATE CASCADE ON DELETE RESTRICT
        )',
    ];

    foreach ($schema as $sql) {
        $db->exec($sql);
    }

    return $db;
}

/**
 * Seed sample data for tests.
 *
 * @return array IDs of created records
 */
function seed_sample_data(PDO $db): array
{
    $db->exec("INSERT INTO companies (name) VALUES ('Acme Inc')");
    $companyId = (int) $db->lastInsertId();

    $db->exec("INSERT INTO stores (company_id, name, location) VALUES ($companyId, 'Main Store', 'HQ')");
    $storeId = (int) $db->lastInsertId();

    $hash = hash('sha256', 'user@example.com');
    $db->exec("INSERT INTO users (company_id, email, emailHash, password_hash, home_store_id) VALUES ($companyId, 'user@example.com', '$hash', 'hash', $storeId)");
    $userId = (int) $db->lastInsertId();

    $db->exec("INSERT INTO roles (name) VALUES ('admin')");
    $roleId = (int) $db->lastInsertId();

    $db->exec("INSERT INTO role_permissions (role_id, permission) VALUES ($roleId, 'manage')");

    $db->exec("INSERT INTO user_company_roles (user_id, company_id, role) VALUES ($userId, $companyId, 'admin')");
    $db->exec("INSERT INTO user_store_roles (user_id, store_id, role) VALUES ($userId, $storeId, 'manager')");

    $db->exec("INSERT INTO staff (store_id, company_id, name, lunch_duration, isAdmin) VALUES ($storeId, $companyId, 'Alice', 30, 0)");
    $staffId = (int) $db->lastInsertId();

    return [
        'company_id' => $companyId,
        'store_id'   => $storeId,
        'user_id'    => $userId,
        'role_id'    => $roleId,
        'staff_id'   => $staffId,
    ];
}

/**
 * Close the in-memory database.
 */
function teardown_test_db(?PDO &$db): void
{
    if ($db instanceof PDO) {
        $db = null;
    }
}

