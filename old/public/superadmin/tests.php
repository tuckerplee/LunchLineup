<?php
require_once __DIR__ . '/../../src/data.php';

$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Tests</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item active" aria-current="page">Tests</li>
        </ol>
    </nav>
    <h1>Tests</h1>
    <p class="mb-3">Run backend test scripts. Results are captured without modifying the existing configuration.</p>
    <div class="row g-3 align-items-end">
        <div class="col-sm-6 col-lg-4">
            <label for="testFilter" class="form-label">Filter (optional)</label>
            <input id="testFilter" type="text" class="form-control" placeholder="Enter filename substring" autocomplete="off" />
        </div>
        <div class="col-sm-auto">
            <button id="runTests" class="btn btn-primary">Run Tests</button>
        </div>
    </div>
    <pre id="results" class="mt-3 bg-body-tertiary p-3 border rounded" style="min-height: 200px; white-space: pre-wrap;"></pre>
    <script>
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const btn = document.getElementById('runTests');
        const out = document.getElementById('results');
        const filterInput = document.getElementById('testFilter');

        function renderResults(data) {
            const lines = [];
            if (data.summary) {
                const passed = data.summary.passed ?? 0;
                const total = data.summary.total ?? 0;
                const failed = data.summary.failed ?? Math.max(total - passed, 0);
                let summaryLine = `Summary: ${passed}/${total} tests passed`;
                if (failed > 0) {
                    summaryLine += `, ${failed} failed`;
                }
                lines.push(summaryLine);
            }
            if (Object.prototype.hasOwnProperty.call(data, 'configRestored')) {
                lines.push(data.configRestored ? 'Configuration restored successfully.' : 'Warning: config.php was not restored to its original state.');
            }
            if (Array.isArray(data.results)) {
                data.results.forEach((result) => {
                    lines.push(`▶ ${result.file}`);
                    if (result.stdout) {
                        lines.push(result.stdout);
                    }
                    if (result.stderr) {
                        lines.push(result.stderr);
                    }
                    if (result.message) {
                        lines.push(result.message);
                    }
                    const label = result.passed ? `✔ ${result.file} passed` : `✘ ${result.file} failed (exit code ${result.exitCode})`;
                    lines.push(label);
                    lines.push('');
                });
            }
            if (data.message) {
                lines.push(data.message);
            }
            if (data.status === 'fail') {
                lines.push(`Suite exit code: ${data.exitCode}`);
            }
            const text = lines.join('\n').trim();
            out.textContent = text === '' ? 'No output.' : text;
        }

        btn.addEventListener('click', () => {
            btn.disabled = true;
            out.textContent = 'Running tests...';
            const params = new URLSearchParams();
            params.set('token', TOKEN);
            const filter = filterInput.value.trim();
            if (filter !== '') {
                params.set('filter', filter);
            }

            fetch('../superadmin-api/tests.php?' + params.toString(), { method: 'POST' })
                .then(r => r.json())
                .then(data => {
                    if (!data || typeof data !== 'object') {
                        throw new Error('Invalid response');
                    }
                    if (data.status === 'error') {
                        out.textContent = data.message || 'Error running tests.';
                        return;
                    }
                    renderResults(data);
                })
                .catch(() => {
                    out.textContent = 'Error running tests.';
                })
                .finally(() => {
                    btn.disabled = false;
                });
        });
    })();
    </script>
</body>
</html>
