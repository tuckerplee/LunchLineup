<?php
declare(strict_types=1);

$configFile = __DIR__ . '/../config.php';
if (!is_readable($configFile)) {
    http_response_code(500);
    echo '<h1>Configuration Missing</h1>';
    echo '<p>Create config.php via setup.php before running upgrades.</p>';
    exit;
}

require $configFile;
require_once __DIR__ . '/../src/data.php';
require_once __DIR__ . '/../src/upgrade.php';

$adminUsernameUpgrade = __DIR__ . '/../scripts/upgrades/upgrade_20250221_admin_username_prompt.php';
if (is_readable($adminUsernameUpgrade)) {
    require_once $adminUsernameUpgrade;
}

session_start();

$errors         = [];
$successMessage = null;
$upgradeResults = [];
$authenticated  = isset($_SESSION['upgrade_user_id']) && (int) $_SESSION['upgrade_user_id'] > 0;
$submittedAccountUsernames = [];
$action = $_POST['action'] ?? '';

if ($_SERVER['REQUEST_METHOD'] === 'POST') {
    if ($action === 'logout') {
        unset($_SESSION['upgrade_user_id'], $_SESSION['upgrade_username']);
        $authenticated = false;
    } elseif ($authenticated && $action === 'run') {
        if (isset($_POST['account_username']) && is_array($_POST['account_username'])) {
            foreach ($_POST['account_username'] as $userId => $username) {
                $submittedAccountUsernames[(int) $userId] = trim((string) $username);
            }
        }
    } else {
        $username = trim($_POST['username'] ?? '');
        $password = (string) ($_POST['password'] ?? '');
        try {
            $user = authenticateSuperAdmin($username, $password);
            $_SESSION['upgrade_user_id'] = $user['id'];
            $_SESSION['upgrade_username'] = $user['username'];
            header('Location: update.php');
            exit;
        } catch (RuntimeException $exception) {
            $errors[] = $exception->getMessage();
        } catch (Throwable $exception) {
            $errors[] = 'Unexpected error: ' . $exception->getMessage();
        }
        $authenticated = isset($_SESSION['upgrade_user_id']) && (int) $_SESSION['upgrade_user_id'] > 0;
    }
}

$pendingAccounts = [];
$shouldRunUpgrades    = $authenticated && $errors === [];
if ($authenticated && class_exists(Upgrade20250221AdminUsernamePrompt::class) && $errors === []) {
    try {
        $pendingAccounts = Upgrade20250221AdminUsernamePrompt::pendingAdminAccounts();
    } catch (Throwable $exception) {
        $errors[]          = 'Failed to check account usernames: ' . $exception->getMessage();
        $shouldRunUpgrades = false;
    }
}

if ($shouldRunUpgrades && $pendingAccounts !== []) {
    if ($action === 'run') {
        $provided = [];
        foreach ($pendingAccounts as $account) {
            $userId   = (int) ($account['id'] ?? 0);
            $username = $submittedAccountUsernames[$userId] ?? '';
            if ($username === '') {
                $errors[] = 'Provide a username for user account #' . $userId . '.';
            } else {
                $provided[$userId] = $username;
            }
        }
        if ($errors === []) {
            Upgrade20250221AdminUsernamePrompt::setProvidedUsernames($provided);
        } else {
            $shouldRunUpgrades = false;
        }
    } else {
        $shouldRunUpgrades = false;
        if ($successMessage === null) {
            $successMessage = 'Enter usernames for the user accounts listed below, then rerun the upgrade.';
        }
    }
}

if ($authenticated) {
    $userId = (int) $_SESSION['upgrade_user_id'];
    set_audit_user($userId);
    if ($shouldRunUpgrades && $errors === []) {
        try {
            $upgradeResults = UpgradeCoordinator::runPending();
            if ($upgradeResults === []) {
                $successMessage = 'No upgrade scripts were found.';
            } else {
                $hasApplied = false;
                foreach ($upgradeResults as $result) {
                    if ($result['status'] === 'applied') {
                        $hasApplied = true;
                        break;
                    }
                }
                $successMessage = $hasApplied
                    ? 'Pending upgrades completed.'
                    : 'All upgrades have already been applied.';
            }
            if (class_exists(Upgrade20250221AdminUsernamePrompt::class)) {
                $pendingAccounts = Upgrade20250221AdminUsernamePrompt::pendingAdminAccounts();
            }
        } catch (Throwable $exception) {
            $errors[] = 'Failed to run upgrades: ' . $exception->getMessage();
        }
    }
}

function authenticateSuperAdmin(string $username, string $password): array
{
    if ($username === '' || $password === '') {
        throw new RuntimeException('Username and password are required.');
    }

    try {
        $db = getDb();
    } catch (Throwable $exception) {
        throw new RuntimeException('Unable to connect to the database: ' . $exception->getMessage(), 0, $exception);
    }

    $userRow      = null;
    $usernameCol  = getUserUsernameColumn();

    try {
        try {
            $usernameHashColumn = getUserUsernameHashColumn();
            $stmt = $db->prepare(
                'SELECT id, ' . $usernameCol . ' AS username_value, password_hash, locked_until FROM users WHERE '
                . $usernameHashColumn . ' = ? LIMIT 1'
            );
            $stmt->execute([usernameHash($username)]);
            $row = $stmt->fetch(PDO::FETCH_ASSOC);
            if ($row !== false) {
                $row['username'] = decryptField((string) $row['username_value']);
                $userRow = $row;
            }
        } catch (RuntimeException $exception) {
            // Fallback to legacy scan if the hashed username column is unavailable.
            $stmt = $db->query('SELECT id, ' . $usernameCol . ' AS username_value, password_hash, locked_until FROM users');
            while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                $decrypted = decryptField((string) $row['username_value']);
                if (strcasecmp($decrypted, $username) === 0) {
                    $row['username'] = $decrypted;
                    $userRow = $row;
                    break;
                }
            }
        }

        if ($userRow === null) {
            $stmt = $db->query('SELECT id, ' . $usernameCol . ' AS username_value, password_hash, locked_until FROM users');
            while ($row = $stmt->fetch(PDO::FETCH_ASSOC)) {
                $decrypted = decryptField((string) $row['username_value']);
                if (strcasecmp($decrypted, $username) === 0) {
                    $row['username'] = $decrypted;
                    $userRow = $row;
                    break;
                }
            }
        }
    } catch (PDOException $exception) {
        throw new RuntimeException('Unable to look up user credentials: ' . $exception->getMessage(), 0, $exception);
    }

    if ($userRow === null) {
        throw new RuntimeException('Super admin account not found.');
    }

    if (!empty($userRow['locked_until']) && strtotime((string) $userRow['locked_until']) > time()) {
        throw new RuntimeException('This account is locked. Try again later or reset the password.');
    }

    if (!password_verify($password, (string) $userRow['password_hash'])) {
        throw new RuntimeException('Invalid credentials.');
    }

    $userId = (int) $userRow['id'];
    if (!is_super_admin($userId)) {
        throw new RuntimeException('The provided account is not a super admin.');
    }

    return ['id' => $userId, 'username' => (string) $userRow['username']];
}

function statusBadgeClass(string $status): string
{
    return match ($status) {
        'applied' => 'bg-success',
        'failed'  => 'bg-danger',
        'pending' => 'bg-warning text-dark',
        default   => 'bg-secondary',
    };
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Upgrade Coordinator</title>
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
</head>
<body class="bg-light">
    <div class="container py-5">
        <div class="row justify-content-center">
            <div class="col-lg-8">
                <div class="card shadow-sm">
                    <div class="card-body p-4">
                        <h1 class="h3 mb-4">Database Upgrade Coordinator</h1>
                        <?php if ($errors !== []) : ?>
                            <div class="alert alert-danger" role="alert">
                                <ul class="mb-0">
                                    <?php foreach ($errors as $error) : ?>
                                        <li><?php echo htmlspecialchars($error, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></li>
                                    <?php endforeach; ?>
                                </ul>
                            </div>
                        <?php endif; ?>

                        <?php if (!$authenticated) : ?>
                            <form method="post" class="needs-validation" novalidate>
                                <div class="mb-3">
                                    <label for="username" class="form-label">Super Admin Username</label>
                                    <input type="text" class="form-control" id="username" name="username" required autocomplete="username">
                                </div>
                                <div class="mb-3">
                                    <label for="password" class="form-label">Password</label>
                                    <input type="password" class="form-control" id="password" name="password" required autocomplete="current-password">
                                </div>
                                <input type="hidden" name="action" value="login">
                                <button type="submit" class="btn btn-primary w-100">Sign In</button>
                            </form>
                        <?php else : ?>
                            <p class="text-muted mb-4">
                                Signed in as <strong><?php echo htmlspecialchars((string) ($_SESSION['upgrade_username'] ?? ''), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></strong>.
                            </p>
                            <?php if ($successMessage !== null) : ?>
                                <div class="alert alert-success" role="alert">
                                    <?php echo htmlspecialchars($successMessage, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>
                                </div>
                            <?php endif; ?>
                            <?php if ($pendingAccounts !== []) : ?>
                                <div class="alert alert-warning" role="alert">
                                    Some user accounts still use e-mail style logins. Provide new usernames below to
                                    finish the migration, then rerun the upgrade.
                                </div>
                                <form method="post" class="mb-4">
                                    <input type="hidden" name="action" value="run">
                                    <?php foreach ($pendingAccounts as $account) :
                                        $userId    = (int) ($account['id'] ?? 0);
                                        $roles     = array_filter((array) ($account['roles'] ?? []));
                                        $current   = trim((string) ($account['current'] ?? ''));
                                        $suggested = (string) ($account['suggestion'] ?? '');
                                        $value     = $submittedAccountUsernames[$userId]
                                            ?? ($suggested !== '' ? $suggested : $current);
                                    ?>
                                        <div class="mb-3">
                                            <label class="form-label">
                                                User Account #<?php echo $userId; ?>
                                                <?php if ($current !== '') : ?>
                                                    <span class="text-muted">(current: <?php echo htmlspecialchars($current, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>)</span>
                                                <?php endif; ?>
                                            </label>
                                            <input
                                                type="text"
                                                class="form-control"
                                                name="account_username[<?php echo $userId; ?>]"
                                                value="<?php echo htmlspecialchars($value, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>"
                                                required
                                                pattern="[A-Za-z0-9._-]{3,64}"
                                                maxlength="64"
                                                autocomplete="off"
                                            >
                                            <div class="form-text">
                                                <?php
                                                $roleText = $roles !== [] ? implode(', ', $roles) : 'company access';
                                                echo htmlspecialchars('Roles: ' . $roleText, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8');
                                                ?>
                                            </div>
                                        </div>
                                    <?php endforeach; ?>
                                    <button type="submit" class="btn btn-primary">
                                        Save Usernames &amp; Run Upgrades
                                    </button>
                                </form>
                            <?php endif; ?>
                            <?php if ($upgradeResults !== []) : ?>
                                <div class="table-responsive mb-4">
                                    <table class="table table-striped align-middle">
                                        <thead>
                                            <tr>
                                                <th scope="col">Upgrade</th>
                                                <th scope="col">Status</th>
                                                <th scope="col">Details</th>
                                            </tr>
                                        </thead>
                                        <tbody>
                                            <?php foreach ($upgradeResults as $result) : ?>
                                                <tr>
                                                    <th scope="row"><?php echo htmlspecialchars((string) $result['name'], ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></th>
                                                    <td>
                                                        <span class="badge <?php echo statusBadgeClass((string) $result['status']); ?>">
                                                            <?php echo htmlspecialchars((string) ucfirst((string) $result['status']), ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?>
                                                        </span>
                                                    </td>
                                                    <td>
                                                        <?php if (!empty($result['messages'])) : ?>
                                                            <ul class="mb-0 ps-3">
                                                                <?php foreach ($result['messages'] as $message) : ?>
                                                                    <li><?php echo htmlspecialchars((string) $message, ENT_QUOTES | ENT_SUBSTITUTE, 'UTF-8'); ?></li>
                                                                <?php endforeach; ?>
                                                            </ul>
                                                        <?php else : ?>
                                                            <span class="text-muted">No messages.</span>
                                                        <?php endif; ?>
                                                    </td>
                                                </tr>
                                            <?php endforeach; ?>
                                        </tbody>
                                    </table>
                                </div>
                            <?php endif; ?>
                            <div class="d-flex gap-2">
                                <?php if ($pendingAccounts === []) : ?>
                                    <form method="post">
                                        <input type="hidden" name="action" value="run">
                                        <button type="submit" class="btn btn-primary">Run Again</button>
                                    </form>
                                <?php endif; ?>
                                <form method="post">
                                    <input type="hidden" name="action" value="logout">
                                    <button type="submit" class="btn btn-outline-secondary">Sign Out</button>
                                </form>
                            </div>
                        <?php endif; ?>
                    </div>
                </div>
            </div>
        </div>
    </div>
</body>
</html>
