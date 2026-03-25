<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false || empty($auth['isSuperAdmin'])) {
    header('Location: ../index.php');
    exit;
}
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Companies</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/calendar.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
</head>
<body class="p-4">
    <nav aria-label="breadcrumb" class="mb-3">
        <ol class="breadcrumb">
            <li class="breadcrumb-item"><a href="#" data-breadcrumb>Dashboard</a></li>
            <li class="breadcrumb-item active" aria-current="page">Companies</li>
        </ol>
    </nav>
    <h1>Companies</h1>
    <table class="table mb-4" id="companyTable">
        <thead><tr><th>ID</th><th>Name</th><th></th></tr></thead>
        <tbody></tbody>
    </table>
    <h2 id="formTitle">New Company</h2>
    <form id="companyForm">
        <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
        <input type="hidden" id="companyId" />
        <div class="mb-3">
            <label class="form-label">Name
                <input type="text" id="name" class="form-control" required />
            </label>
        </div>
        <button type="submit" class="btn btn-primary">Save</button>
        <button type="button" class="btn btn-link" id="backBtn">Back</button>
    </form>
    <script>
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        function loadCompanies() {
            fetch(`../api/companies.php?token=${encodeURIComponent(TOKEN)}`)
                .then((r) => r.json())
                .then((data) => {
                    const tbody = document.querySelector('#companyTable tbody');
                    tbody.replaceChildren();
                    data.forEach((c) => {
                        const tr = document.createElement('tr');
                        tr.innerHTML = `<td>${c.id}</td><td>${c.name}</td>`;
                        const td = document.createElement('td');

                        const manage = document.createElement('button');
                        manage.textContent = 'Manage';
                        manage.className = 'btn btn-sm btn-primary me-2';
                        manage.addEventListener('click', () => {
                            const url = `company_manage.php?company_id=${c.id}`;
                            const title = `Manage ${c.name}`;
                            if (typeof openAdminModal === 'function') {
                                openAdminModal(url, title);
                            } else {
                                window.location.href = url;
                            }
                        });

                        const edit = document.createElement('button');
                        edit.textContent = 'Edit';
                        edit.className = 'btn btn-sm btn-secondary me-2';
                        edit.addEventListener('click', () => {
                            document.getElementById('companyId').value = c.id;
                            document.getElementById('name').value = c.name;
                            document.getElementById('formTitle').textContent = 'Edit Company';
                        });

                        const del = document.createElement('button');
                        del.textContent = 'Delete';
                        del.className = 'btn btn-sm btn-danger';
                        del.addEventListener('click', () => {
                            if (!confirm('Delete company?')) return;
                            fetch(`../api/companies.php?id=${c.id}&token=${encodeURIComponent(TOKEN)}`, { method: 'DELETE' })
                                .then(() => loadCompanies());
                        });

                        td.appendChild(manage);
                        td.appendChild(edit);
                        td.appendChild(del);
                        tr.appendChild(td);
                        tbody.appendChild(tr);
                    });
                });
        }
        document.getElementById('companyForm').addEventListener('submit', (e) => {
            e.preventDefault();
            const payload = {
                id: document.getElementById('companyId').value || undefined,
                name: document.getElementById('name').value,
            };
            fetch(`../api/companies.php?token=${encodeURIComponent(TOKEN)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
            }).then(() => {
                document.getElementById('companyId').value = '';
                document.getElementById('name').value = '';
                document.getElementById('formTitle').textContent = 'New Company';
                loadCompanies();
            });
        });
        document.getElementById('backBtn').addEventListener('click', () => {
            if (typeof adminModalClose === 'function') {
                adminModalClose();
            } else {
                window.location.href = 'index.php';
            }
        });
        loadCompanies();
    })();
    </script>
</body>
</html>
