<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';

function issueToken(int $userId): array|false
{
    $db = getDb();
    $stmt = $db->prepare('SELECT company_id, home_store_id FROM users WHERE id = ?');
    $stmt->execute([$userId]);
    $user = $stmt->fetch(PDO::FETCH_ASSOC);
    if (!$user) {
        return false;
    }
    $userCompanyId = (int) $user['company_id'];
    $homeStoreId   = (int) $user['home_store_id'];

    $roles  = fetch_user_store_roles($userId);
    $stores = array_map(static fn($r) => (int) $r['store_id'], $roles);
    if ($homeStoreId > 0 && !in_array($homeStoreId, $stores, true)) {
        $stores[] = $homeStoreId;
    }
    $stores = array_values(array_unique($stores));
    $companyMap = [];
    foreach ($stores as $sid) {
        $cid = get_store_company_id($sid);
        if ($cid !== null) {
            $companyMap[$cid] = true;
        }
    }
    $cRoles = fetch_user_company_roles($userId);
    foreach ($cRoles as $r) {
        $companyMap[(int) $r['company_id']] = true;
    }
    $isSuperAdmin = is_super_admin($userId);
    if ($isSuperAdmin) {
        $stores    = array_map(static fn($r) => (int) $r['id'], fetchStores());
        $companies = array_map(static fn($r) => (int) $r['id'], fetchCompanies());
    } else {
        $companies = array_map('intval', array_keys($companyMap));
        if ($companies === []) {
            $companies = [$userCompanyId];
        }
    }
    $payload = [
        'sub'          => $userId,
        'stores'       => $stores,
        'exp'          => time() + 7200,
        'isSuperAdmin' => $isSuperAdmin,
    ];
    $isCompanyAdmin = false;
    if (count($companies) === 1) {
        $payload['company_id'] = $companies[0];
        $isCompanyAdmin = is_company_admin($userId, $companies[0]);
    } else {
        $payload['companies'] = $companies;
        foreach ($companies as $cid) {
            if (is_company_admin($userId, $cid)) {
                $isCompanyAdmin = true;
                break;
            }
        }
    }
    if ($isCompanyAdmin) {
        $payload['isCompanyAdmin'] = true;
    }
    $token = createJwt($payload);
    if ($token === false) {
        return false;
    }
    setcookie('token', $token, [
        'expires'  => time() + 7200,
        'path'     => '/',
        'secure'   => isset($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off',
        'httponly' => true,
        'samesite' => 'Lax',
    ]);
    $resp = ['status' => 'ok', 'token' => $token, 'isSuperAdmin' => $isSuperAdmin];
    if ($isCompanyAdmin && isset($payload['company_id'])) {
        $resp['isCompanyAdmin'] = true;
        $resp['companyId']      = $payload['company_id'];
    }
    return $resp;
}

if ($method === 'POST') {
    $payload = read_json_body();
    $username = trim($payload['username'] ?? '');
    $password = trim($payload['password'] ?? '');
    $ip = $_SERVER['REMOTE_ADDR'] ?? '';
    $db = getDb();
    $user          = null;
    $userId        = null;
    $userCompanyId = 1;
    $homeStoreId   = 0;
    try {
        $usernameHashColumn = getUserUsernameHashColumn();
        $usernameColumn     = getUserUsernameColumn();
    } catch (RuntimeException $exception) {
        $message = $exception->getMessage();
        error_log('[auth] ' . $message);
        jsonError($message, 500);
    }

    try {
        $stmt = $db->prepare(
            'SELECT id, ' . $usernameColumn . ' AS username_value, password_hash, locked_until, company_id, home_store_id FROM users WHERE '
            . $usernameHashColumn . ' = ?'
        );
        $stmt->execute([usernameHash($username)]);
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    } catch (PDOException $exception) {
        $message = 'Failed to query user login data. Run "php scripts/upgrade.php" so the users username columns exist before retrying.';
        error_log('[auth] ' . $message . ' Error: ' . $exception->getMessage());
        jsonError($message, 500);
    }
    if ($row !== false) {
        $user          = $row;
        $userId        = (int) $row['id'];
        $userCompanyId = (int) $row['company_id'];
        $homeStoreId   = (int) $row['home_store_id'];
    }
    if ($user && $user['locked_until'] !== null && strtotime($user['locked_until']) > time()) {
        jsonError('Account locked', 423);
    }
    if (!$user || !password_verify($password, $user['password_hash'])) {
        if ($userId !== null) {
            $db->prepare(
                'INSERT INTO login_attempts (user_id, ip, attempts, last_attempt) VALUES (?, ?, 1, NOW()) '
                . 'ON DUPLICATE KEY UPDATE attempts = attempts + 1, last_attempt = NOW()'
            )->execute([$userId, $ip]);
            $attemptStmt = $db->prepare('SELECT attempts FROM login_attempts WHERE user_id = ? AND ip = ?');
            $attemptStmt->execute([$userId, $ip]);
            $attempts = (int) $attemptStmt->fetchColumn();
            if ($attempts >= 5) {
                $db->prepare('UPDATE users SET locked_until = DATE_ADD(NOW(), INTERVAL 15 MINUTE) WHERE id = ?')->execute([$userId]);
                $db->prepare('DELETE FROM login_attempts WHERE user_id = ?')->execute([$userId]);
                jsonError('Account locked', 423);
            }
        }
        jsonError('Invalid credentials', 401);
    }
    if ($userId !== null) {
        $db->prepare('UPDATE users SET locked_until = NULL WHERE id = ?')->execute([$userId]);
        $db->prepare('DELETE FROM login_attempts WHERE user_id = ?')->execute([$userId]);
    }
    $resp = issueToken($userId);
    if ($resp === false) {
        jsonError('JWT secret not configured', 500);
    }
    echo json_encode($resp);
    exit;
}

if ($method === 'GET') {
    $token = $_COOKIE['token'] ?? '';
    $auth  = verify_api_token($token);
    if ($auth === false) {
        jsonError('Invalid token', 401);
    }
    $resp = issueToken((int) $auth['sub']);
    if ($resp === false) {
        jsonError('JWT secret not configured', 500);
    }
    echo json_encode($resp);
    exit;
}

if ($method === 'DELETE') {
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);
