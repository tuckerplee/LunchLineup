<?php
require_once __DIR__ . '/../../src/data.php';
$token = $_COOKIE['token'] ?? '';
$auth  = verify_api_token($token);
if ($auth === false) {
    header('Location: ../index.php');
    exit;
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = isset($_GET['company_id']) ? (int) $_GET['company_id'] : 0;
if ($companyId === 0) {
    http_response_code(400);
    echo 'Missing company_id';
    exit;
}
if (!in_array($companyId, $auth['companies'] ?? [], true) && empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}
if (!is_company_admin($userId, $companyId) && empty($auth['isSuperAdmin'])) {
    http_response_code(403);
    echo 'Forbidden';
    exit;
}
$csrf = generate_csrf_token();
?>
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8" />
    <title>Automation Settings</title>
    <link rel="icon" href="https://cdn.jsdelivr.net/npm/heroicons@2.2.0/24/solid/arrow-path.svg" type="image/svg+xml">
    <link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.2/dist/css/bootstrap.min.css" rel="stylesheet" />
    <style>
        .drop-zone {
            border: 2px dashed #0d6efd;
            border-radius: 0.5rem;
            min-height: 1500px;
            padding: 2rem;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #6c757d;
            background-color: #f8f9fa;
            box-shadow: inset 0 0 0.75rem rgba(13, 110, 253, 0.1);
            transition: background-color 0.15s ease-in-out, box-shadow 0.15s ease-in-out;
        }
        .drop-zone.dragover {
            background-color: #e7f1ff;
            box-shadow: inset 0 0 0.75rem rgba(13, 110, 253, 0.25);
        }
    </style>
</head>
<body class="p-4">
    <h1>Automation Settings</h1>
    <p class="mb-4">Drag rules from the library into your active rule set and reorder as needed.</p>
    <div class="row">
        <div class="col-md-4">
            <h2 class="h5">Rule Library</h2>
            <ul id="ruleLibrary" class="list-group mb-4"></ul>
        </div>
        <div class="col-md-8">
            <div class="d-flex mb-3">
                <select id="templateSelect" class="form-select me-2"></select>
                <button id="loadTemplate" class="btn btn-secondary me-2">Load Template</button>
                <button id="saveTemplate" class="btn btn-outline-primary">Save Template</button>
            </div>
            <button id="addRule" class="btn btn-primary mb-3">Add Rule</button>
            <form id="ruleForm" class="mb-4 d-none">
                <input type="hidden" name="csrf_token" value="<?php echo htmlspecialchars($csrf, ENT_QUOTES); ?>" />
                <input type="hidden" id="ruleId" />
                <div class="mb-3">
                    <label class="form-label">Name
                        <input type="text" id="ruleName" class="form-control" required />
                    </label>
                </div>
                <div class="mb-3">
                    <label class="form-label">Action
                        <input type="text" id="ruleAction" class="form-control" required />
                    </label>
                </div>
                <div class="mb-3">
                    <label class="form-label">Description
                        <input type="text" id="ruleDescription" class="form-control" required />
                    </label>
                </div>
                <button type="submit" class="btn btn-success">Save</button>
                <button type="button" class="btn btn-link" id="cancelEdit">Cancel</button>
            </form>
            <div id="dropZone" class="drop-zone card mb-3 text-center">Drop Rules Here</div>
            <ul id="ruleList" class="list-group"></ul>
        </div>
    </div>
    <script src="../assets/js/modules/admin-nav.js"></script>
    <script>
    window.COMPANY_ID = <?php echo $companyId; ?>;
    (function () {
        const TOKEN = "<?php echo htmlspecialchars($token, ENT_QUOTES); ?>";
        const libraryTemplates = [
            {
                name: 'Two-Employee Sequential Breaks',
                action: 'twoSequential',
                description: 'First employee breaks two hours after start, second follows sequentially.'
            },
            {
                name: 'Staggered Breaks for Large Team',
                action: 'staggeredTeam',
                description: 'Dynamic staggering allows overlapping breaks for teams up to ten people.'
            }
        ];
        let rules = JSON.parse(localStorage.getItem('automationRules') || '[]');
        let templates = [];
        let dragType = '';
        let draggedIndex = null;
        let draggedTemplate = null;
        let editId = 0;

        const libraryEl = document.getElementById('ruleLibrary');
        const listEl = document.getElementById('ruleList');
        const dropZone = document.getElementById('dropZone');
        const formEl = document.getElementById('ruleForm');
        const addBtn = document.getElementById('addRule');
        const cancelBtn = document.getElementById('cancelEdit');
        const templateSelect = document.getElementById('templateSelect');
        const loadBtn = document.getElementById('loadTemplate');
        const saveTemplateBtn = document.getElementById('saveTemplate');

        function save() {
            localStorage.setItem('automationRules', JSON.stringify(rules));
        }

        function renderTemplateOptions() {
            templateSelect.replaceChildren(new Option('Select template', ''));
            templates.forEach((t) => {
                const opt = document.createElement('option');
                opt.value = t.id;
                opt.textContent = t.name;
                templateSelect.appendChild(opt);
            });
        }

        async function loadTemplates() {
            const res = await fetch(
                `../admin-api/templates.php?company_id=${window.COMPANY_ID}&token=${TOKEN}`
            );
            if (res.ok) {
                templates = await res.json();
                renderTemplateOptions();
            }
        }

        function renderLibrary() {
            libraryEl.replaceChildren();
            libraryTemplates.forEach((tpl) => {
                const li = document.createElement('li');
                li.className = 'list-group-item';
                li.textContent = tpl.name;
                li.draggable = true;
                li.addEventListener('dragstart', () => {
                    dragType = 'library';
                    draggedTemplate = tpl;
                });
                libraryEl.appendChild(li);
            });
        }

        function renderRules() {
            listEl.replaceChildren();
            dropZone.textContent = rules.length ? 'Drop Additional Rules Here' : 'Drop Rules Here';
            rules.forEach((rule, index) => {
                const li = document.createElement('li');
                li.className = 'list-group-item d-flex justify-content-between align-items-start';
                li.draggable = true;
                li.dataset.index = index.toString();
                li.innerHTML =
                    `<div><strong>${rule.name}</strong><div class="text-muted small">${
                        rule.description || ''
                    }</div></div>` +
                    '<span class="ms-2"><button class="btn btn-sm btn-secondary me-2 edit-rule">Edit</button>' +
                    '<button class="btn btn-sm btn-danger del-rule">Delete</button></span>';

                li.addEventListener('dragstart', () => {
                    dragType = 'active';
                    draggedIndex = index;
                });
                li.addEventListener('dragover', (e) => e.preventDefault());
                li.addEventListener('drop', (e) => {
                    e.preventDefault();
                    const targetIndex = parseInt(li.dataset.index, 10);
                    if (dragType === 'active') {
                        if (draggedIndex === targetIndex) {
                            return;
                        }
                        const [moved] = rules.splice(draggedIndex, 1);
                        rules.splice(targetIndex, 0, moved);
                    } else if (dragType === 'library' && draggedTemplate) {
                        const newRule = {
                            id: Date.now(),
                            name: draggedTemplate.name,
                            action: draggedTemplate.action,
                            description: draggedTemplate.description
                        };
                        rules.splice(targetIndex, 0, newRule);
                    }
                    dragType = '';
                    draggedTemplate = null;
                    save();
                    renderRules();
                });

                li.querySelector('.edit-rule').addEventListener('click', () => {
                    editId = rule.id;
                    formEl.classList.remove('d-none');
                    document.getElementById('ruleId').value = rule.id;
                    document.getElementById('ruleName').value = rule.name;
                    document.getElementById('ruleAction').value = rule.action;
                    document.getElementById('ruleDescription').value = rule.description || '';
                });

                li.querySelector('.del-rule').addEventListener('click', () => {
                    rules = rules.filter((r) => r.id !== rule.id);
                    save();
                    renderRules();
                });

                listEl.appendChild(li);
            });
        }

        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('dragover');
        });

        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('dragover');
        });

        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('dragover');
            if (dragType === 'library' && draggedTemplate) {
                rules.push({
                    id: Date.now(),
                    name: draggedTemplate.name,
                    action: draggedTemplate.action,
                    description: draggedTemplate.description
                });
                dragType = '';
                draggedTemplate = null;
                save();
                renderRules();
            }
        });

        addBtn.addEventListener('click', () => {
            editId = 0;
            formEl.reset();
            formEl.classList.remove('d-none');
            document.getElementById('ruleName').focus();
        });

        cancelBtn.addEventListener('click', () => {
            formEl.classList.add('d-none');
        });

        saveTemplateBtn.addEventListener('click', async () => {
            const name = prompt('Template name');
            if (!name) {
                return;
            }
            await fetch(
                `../admin-api/templates.php?company_id=${window.COMPANY_ID}&token=${TOKEN}`,
                {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, rules }),
                }
            );
            await loadTemplates();
        });

        loadBtn.addEventListener('click', () => {
            const id = parseInt(templateSelect.value, 10);
            const tmpl = templates.find((t) => t.id === id);
            if (!tmpl) {
                return;
            }
            rules = JSON.parse(JSON.stringify(tmpl.rules));
            save();
            renderRules();
        });

        formEl.addEventListener('submit', (e) => {
            e.preventDefault();
            const name = document.getElementById('ruleName').value;
            const action = document.getElementById('ruleAction').value;
            const description = document.getElementById('ruleDescription').value;
            if (editId) {
                const idx = rules.findIndex((r) => r.id === editId);
                if (idx >= 0) {
                    rules[idx].name = name;
                    rules[idx].action = action;
                    rules[idx].description = description;
                }
            } else {
                rules.push({ id: Date.now(), name, action, description });
            }
            save();
            renderRules();
            formEl.classList.add('d-none');
        });

        renderLibrary();
        loadTemplates();
        renderRules();
    })();
    </script>
</body>
</html>
