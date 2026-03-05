<?php
declare(strict_types=1);

require __DIR__ . '/password_crypto.php';
require_once __DIR__ . '/../src/crypto.php';
require_once __DIR__ . '/../src/data/core.php';

/**
 * Capture the current state for all super admin accounts so their credentials and roles survive a restore.
 *
 * @return array<int, array<string, mixed>>
 */
function scheduler_restore_capture_super_admin_state(): array
{
    try {
        $db = getDb();
    } catch (Throwable) {
        return [];
    }

    if (!db_table_has_column('user_company_roles', 'role') || !db_table_has_column('user_company_roles', 'user_id')) {
        return [];
    }

    $stmt = $db->prepare('SELECT DISTINCT user_id FROM user_company_roles WHERE role = :role');
    $stmt->execute([':role' => 'super_admin']);
    $ids = array_map('intval', $stmt->fetchAll(PDO::FETCH_COLUMN));
    if ($ids === []) {
        return [];
    }

    $capture = [];
    $userStmt = $db->prepare('SELECT * FROM users WHERE id = ? LIMIT 1');
    $companyRoleStmt = $db->prepare('SELECT company_id, role FROM user_company_roles WHERE user_id = ?');
    $storeRoleStmt = $db->prepare('SELECT store_id, role FROM user_store_roles WHERE user_id = ?');

    foreach ($ids as $userId) {
        $userStmt->execute([$userId]);
        $userRow = $userStmt->fetch(PDO::FETCH_ASSOC);
        if ($userRow === false) {
            continue;
        }

        $companyRoleStmt->execute([$userId]);
        $companyRoles = $companyRoleStmt->fetchAll(PDO::FETCH_ASSOC);

        $storeRoleStmt->execute([$userId]);
        $storeRoles = $storeRoleStmt->fetchAll(PDO::FETCH_ASSOC);

        $columnsToKeep = [
            'id',
            'username',
            'username_hash',
            'usernameHash',
            // Legacy email columns remain for backward compatibility with older dumps.
            'email',
            'email_hash',
            'emailHash',
            'password_hash',
            'passwordHash',
            'company_id',
            'home_store_id',
            'locked_until',
            'created_at',
            'updated_at',
        ];

        $preservedColumns = [];
        foreach ($columnsToKeep as $column) {
            if (array_key_exists($column, $userRow)) {
                $preservedColumns[$column] = $userRow[$column];
            }
        }

        $capture[] = [
            'user' => $preservedColumns,
            'company_roles' => $companyRoles,
            'store_roles' => $storeRoles,
        ];
    }

    return $capture;
}

/**
 * Reapply captured super admin details after a database restore.
 *
 * @param array<int, array<string, mixed>> $state
 * @return array<string, int>
 */
function scheduler_restore_apply_super_admin_state(array $state): array
{
    $result = [
        'users_updated' => 0,
        'users_inserted' => 0,
        'roles_applied' => 0,
    ];

    if ($state === []) {
        return $result;
    }

    try {
        $db = getDb();
    } catch (Throwable) {
        return $result;
    }

    $hasUsers = static fn(string $column): bool => db_table_has_column('users', $column);
    $hasCompanyRoles = db_table_has_column('user_company_roles', 'role');
    $hasStoreRoles = db_table_has_column('user_store_roles', 'role');

    foreach ($state as $record) {
        $userData = $record['user'] ?? [];
        if (!is_array($userData) || !isset($userData['id'])) {
            continue;
        }

        $userId = (int) $userData['id'];
        if ($userId <= 0) {
            continue;
        }

        $db->beginTransaction();
        try {
            $existsStmt = $db->prepare('SELECT 1 FROM users WHERE id = ? LIMIT 1');
            $existsStmt->execute([$userId]);
            $exists = (bool) $existsStmt->fetchColumn();

            $columns = [];
            $params = [];
            $allowed = [
                'username',
                'username_hash',
                'usernameHash',
                // Allow legacy email columns to support restoring older backups.
                'email',
                'email_hash',
                'emailHash',
                'password_hash',
                'passwordHash',
                'company_id',
                'home_store_id',
                'locked_until',
            ];
            foreach ($allowed as $column) {
                if (array_key_exists($column, $userData) && $hasUsers($column)) {
                    $columns[$column] = $userData[$column];
                }
            }

            if ($exists) {
                if ($columns !== []) {
                    $setParts = [];
                    foreach ($columns as $column => $value) {
                        $setParts[] = $column . ' = ?';
                        $params[] = $value;
                    }
                    if ($hasUsers('updated_at')) {
                        $setParts[] = 'updated_at = CURRENT_TIMESTAMP';
                    }
                    $sql = 'UPDATE users SET ' . implode(', ', $setParts) . ' WHERE id = ?';
                    $params[] = $userId;
                    $stmt = $db->prepare($sql);
                    $stmt->execute($params);
                    if ($stmt->rowCount() > 0) {
                        $result['users_updated']++;
                    }
                }
            } else {
                $insertColumns = ['id'];
                $insertValues = [$userId];
                foreach ($columns as $column => $value) {
                    $insertColumns[] = $column;
                    $insertValues[] = $value;
                }
                if ($hasUsers('created_at')) {
                    $insertColumns[] = 'created_at';
                    $insertValues[] = $userData['created_at'] ?? date('Y-m-d H:i:s');
                }
                if ($hasUsers('updated_at')) {
                    $insertColumns[] = 'updated_at';
                    $insertValues[] = $userData['updated_at'] ?? date('Y-m-d H:i:s');
                }

                $hasPassword = array_key_exists('password_hash', $columns) || array_key_exists('passwordHash', $columns);
                $hasLoginHash = false;
                foreach (['username_hash', 'usernameHash', 'email_hash', 'emailHash'] as $hashColumn) {
                    if (array_key_exists($hashColumn, $columns)) {
                        $hasLoginHash = true;
                        break;
                    }
                }
                $loginColumn = null;
                foreach (['username', 'email'] as $candidate) {
                    if (array_key_exists($candidate, $columns)) {
                        $loginColumn = $candidate;
                        break;
                    }
                }
                if ($loginColumn !== null && $hasPassword && $hasLoginHash) {
                    $placeholders = rtrim(str_repeat('?,', count($insertColumns)), ',');
                    $sql = 'INSERT INTO users (' . implode(', ', $insertColumns) . ') VALUES (' . $placeholders . ')';
                    $stmt = $db->prepare($sql);
                    $stmt->execute($insertValues);
                    $result['users_inserted']++;
                }
            }

            if ($hasCompanyRoles) {
                $roles = $record['company_roles'] ?? [];
                if (is_array($roles)) {
                    $roleStmt = $db->prepare(
                        'REPLACE INTO user_company_roles (user_id, company_id, role) VALUES (?, ?, ?)'
                    );
                    foreach ($roles as $roleRow) {
                        $companyId = isset($roleRow['company_id']) ? (int) $roleRow['company_id'] : 0;
                        $roleName = (string) ($roleRow['role'] ?? '');
                        if ($companyId > 0 && $roleName !== '') {
                            $roleStmt->execute([$userId, $companyId, $roleName]);
                            $result['roles_applied']++;
                        }
                    }
                }
            }

            if ($hasStoreRoles) {
                $roles = $record['store_roles'] ?? [];
                if (is_array($roles)) {
                    $roleStmt = $db->prepare(
                        'REPLACE INTO user_store_roles (user_id, store_id, role) VALUES (?, ?, ?)'
                    );
                    foreach ($roles as $roleRow) {
                        $storeId = isset($roleRow['store_id']) ? (int) $roleRow['store_id'] : 0;
                        $roleName = (string) ($roleRow['role'] ?? '');
                        if ($storeId > 0 && $roleName !== '') {
                            $roleStmt->execute([$userId, $storeId, $roleName]);
                            $result['roles_applied']++;
                        }
                    }
                }
            }

            $db->commit();
        } catch (Throwable $exception) {
            if ($db->inTransaction()) {
                $db->rollBack();
            }
            error_log('[restore] Failed to reapply super admin state for user ' . $userId . ': ' . $exception->getMessage());
        }
    }

    return $result;
}

function transformSql(string $sql, callable $transform): string
{
    $pattern = "/'((?:[^'\\\\]|\\\\.)*)'/";
    return (string)preg_replace_callback($pattern, function (array $matches) use ($transform) {
        $value = stripslashes($matches[1]);
        $new = $transform($value);
        return "'" . addslashes($new) . "'";
    }, $sql);
}

function scheduler_restore_run(string $file, string $password, string &$output = '', ?callable $progress = null): int
{
    $say = static function (string $msg) use (&$output, $progress): void {
        if ($progress !== null) {
            $progress($msg);
        }
        $output .= $msg;
    };

    if (!is_file($file)) {
        $say("File not found\n");
        return 1;
    }

    if ($password === '') {
        $say("Missing password\n");
        return 1;
    }

    $configFile = __DIR__ . '/../config.php';
    if (!file_exists($configFile)) {
        $say("Missing config.php\n");
        return 1;
    }

    $config = require $configFile;
    $superAdminState = scheduler_restore_capture_super_admin_state();

    $say("Decrypting backup...\n");
    $temp = tempnam(sys_get_temp_dir(), 'dump');
    $decryptCmd = 'openssl enc -d -aes-256-cbc -salt -pass pass:' . escapeshellarg($password)
        . ' -in ' . escapeshellarg($file)
        . ' -out ' . escapeshellarg($temp);

    ob_start();
    passthru($decryptCmd, $status);
    $output .= ob_get_clean();
    if ($status !== 0) {
        unlink($temp);
        $say("Decryption failed with exit code $status\n");
        return $status;
    }
    $say("Decryption complete.\n");

    $sql = file_get_contents($temp);
    $sql = transformSql($sql, function (string $value) use ($password): string {
        $decrypted = decrypt_with_password($value, $password);
        if ($decrypted === $value) {
            return $value;
        }
        return encryptField($decrypted);
    });
    file_put_contents($temp, $sql);

    $say("Importing database...\n");
    $importCmd = 'mysql --host=' . escapeshellarg($config['host'])
        . ' --user=' . escapeshellarg($config['user'])
        . ' --password=' . escapeshellarg($config['pass'])
        . ' ' . escapeshellarg($config['dbname'])
        . ' < ' . escapeshellarg($temp);

    ob_start();
    passthru($importCmd, $status);
    $output .= ob_get_clean();
    unlink($temp);

    if ($status !== 0) {
        $say("Import failed with exit code $status\n");
    } else {
        $say("Import complete.\n");
        $restoreSummary = scheduler_restore_apply_super_admin_state($superAdminState);
        if (array_sum($restoreSummary) > 0) {
            $say(
                sprintf(
                    "Reapplied super admin state (users updated: %d, inserted: %d, roles applied: %d).\n",
                    $restoreSummary['users_updated'] ?? 0,
                    $restoreSummary['users_inserted'] ?? 0,
                    $restoreSummary['roles_applied'] ?? 0
                )
            );
        } elseif ($superAdminState !== []) {
            $say("WARNING: Unable to reapply super admin state.\n");
        }
    }

    return $status;
}

if (PHP_SAPI === 'cli' && realpath($argv[0]) === __FILE__) {
    if ($argc < 3) {
        fwrite(STDERR, "Usage: php restore.php <file.sql.enc> <password>\n");
        exit(1);
    }

    $output = '';
    $status = scheduler_restore_run($argv[1], $argv[2], $output);
    if ($output !== '') {
        $stream = $status === 0 ? STDOUT : STDERR;
        fwrite($stream, $output);
    }
    exit($status);
}
