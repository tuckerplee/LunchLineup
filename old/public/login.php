<?php
$config = __DIR__ . '/../config.php';
if (!is_readable($config)) {
    header('Location: setup.php');
    exit;
}

require_once __DIR__ . '/../src/data.php';

$hasSecret = get_jwt_secret() !== false;
if (!$hasSecret) {
    http_response_code(500);
    echo '<h1>Server Misconfigured</h1>';
    echo '<p>Set a JWT secret in config.php or the JWT_SECRET environment variable.</p>';
    exit;
}

$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth !== false) {
    if (!empty($auth['isSuperAdmin'])) {
        header('Location: superadmin/index.php');
    } elseif (!empty($auth['isCompanyAdmin']) && !empty($auth['company_id'])) {
        header('Location: admin/index.php?company_id=' . (int) $auth['company_id']);
    } elseif (!empty($auth['company_id'])) {
        header('Location: app.php?company_id=' . (int) $auth['company_id']);
    } else {
        header('Location: app.php');
    }
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Login - LunchLineup</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet">
    <link rel="preconnect" href="https://images.unsplash.com" crossorigin>
    <link
        rel="preload"
        as="image"
        href="https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80"
        crossorigin
    >
    <style>
        html, body { height: 100%; overflow: hidden; }
        .auth-wrapper { display: flex; height: 100%; overflow: hidden; }
        .auth-form { flex: 1; display: flex; align-items: center; justify-content: center; padding: 2rem; }
        .auth-image {
            flex: 1;
            background: url('https://images.unsplash.com/photo-1494526585095-c41746248156?auto=format&fit=crop&w=1200&q=80') center/cover no-repeat;
            animation: slowZoom 120s ease-in-out infinite alternate;
        }
        .auth-box {
            width: 100%;
            max-width: 400px;
            background: #fff;
            border: 1px solid #dee2e6;
            border-radius: .75rem;
            padding: 2rem;
            box-shadow: 0 .5rem 1rem rgba(0,0,0,.1);
            opacity: 0;
            transform: translateY(-20px);
            animation: floatIn .6s ease-out forwards;
        }
        .auth-logo {
            font-weight: 700;
            font-size: clamp(1.5rem, 2vw + 1rem, 2.5rem);
            text-align: center;
            color: #0d6efd;
        }
        .auth-logo a {
            color: inherit;
            text-decoration: none;
        }
        .view { display: none; }
        .view.active { display: block; animation: fadeIn .4s ease; }
        .btn { transition: transform .15s ease, box-shadow .15s ease; }
        .btn:hover { transform: translateY(-2px); box-shadow: 0 .5rem 1rem rgba(0,0,0,.15); }
        .btn:active { transform: translateY(0); box-shadow: 0 .25rem .5rem rgba(0,0,0,.1); }
        @keyframes floatIn { to { opacity: 1; transform: translateY(0); } }
        @keyframes fadeIn { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: translateY(0); } }
        @keyframes slowZoom { from { transform: scale(1); } to { transform: scale(1.05); } }
    </style>
</head>
<body>
    <div class="auth-wrapper">
        <div class="auth-form">
            <div class="auth-box">
                <div id="loginView" class="view active">
                    <h1 class="auth-logo mb-4"><a href="index.php">LunchLineup</a></h1>
                    <h2 class="mb-3">Login</h2>
                    <form id="loginForm">
                        <div class="mb-3">
                            <label for="username" class="form-label">Username</label>
                            <input type="text" class="form-control" id="username" required>
                        </div>
                        <div class="mb-3">
                            <label for="password" class="form-label">Password</label>
                            <input type="password" class="form-control" id="password" required>
                        </div>
                        <button type="submit" class="btn btn-primary w-100">Login</button>
                        <div class="text-center mt-3">
                            <a href="#" id="showRegister">Need an account? Register</a>
                        </div>
                    </form>
                </div>
                <div id="registerView" class="view">
                    <h1 class="auth-logo mb-4"><a href="index.php">LunchLineup</a></h1>
                    <h2 class="mb-3">Register</h2>
                    <form id="registerForm">
                        <div class="mb-3">
                            <label for="regUsername" class="form-label">Username</label>
                            <input type="text" class="form-control" id="regUsername" required>
                        </div>
                        <div class="mb-3">
                            <label for="inviteCode" class="form-label">Invite Code</label>
                            <input type="text" class="form-control" id="inviteCode" required>
                        </div>
                        <button type="submit" class="btn btn-primary w-100">Register</button>
                        <div class="text-center mt-3">
                            <a href="#" id="showLogin">Back to login</a>
                        </div>
                    </form>
                </div>
            </div>
        </div>
        <div class="auth-image"></div>
    </div>
    <script src="assets/js/login.js"></script>
</body>
</html>
