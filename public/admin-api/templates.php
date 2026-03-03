<?php
require_once __DIR__ . '/../../src/data.php';

header('Content-Type: application/json');
$method = $_SERVER['REQUEST_METHOD'];
$token  = requestParam('token');
$auth   = verify_api_token($token);
if ($auth === false) {
    jsonError('Forbidden', 403);
}
$userId    = (int) ($auth['sub'] ?? 0);
$companyId = (int) requestParam('company_id', 0);
$isSuper   = !empty($auth['isSuperAdmin']);
set_audit_user($userId);
set_audit_company($companyId);
if ($companyId === 0) {
    jsonError('Missing company_id', 400);
}
if (!in_array($companyId, $auth['companies'] ?? [], true) && !$isSuper) {
    jsonError('Forbidden', 403);
}
require_csrf_token();

if ($method === 'GET') {
    $templates = fetch_automation_templates($companyId);
    if ($templates === []) {
        $break = fetch_break_template($companyId);
        $templates = [
            [
                'id' => 1,
                'name' => 'Default Break Policy',
                'rules' => [
                    [
                        'id' => 1,
                        'name' => 'Break 1',
                        'action' => 'break',
                        'description' => 'After ' . $break['break1Offset'] . 'h for ' . $break['break1Duration'] . 'm',
                    ],
                    [
                        'id' => 2,
                        'name' => 'Lunch',
                        'action' => 'lunch',
                        'description' => 'After ' . $break['lunchOffset'] . 'h for ' . $break['lunchDuration'] . 'm',
                    ],
                    [
                        'id' => 3,
                        'name' => 'Break 2',
                        'action' => 'break',
                        'description' => 'After ' . $break['break2Offset'] . 'h for ' . $break['break2Duration'] . 'm',
                    ],
                ],
            ],
        ];
        save_automation_templates($templates, $companyId);
    }
    echo json_encode($templates);
    exit;
}

if ($method === 'POST') {
    if (!is_company_admin($userId, $companyId) && !$isSuper) {
        jsonError('Forbidden', 403);
    }
    $payload = read_json_body();
    if (!is_array($payload)) {
        jsonError('Invalid template', 400);
    }
    $templates = fetch_automation_templates($companyId);
    $id = isset($payload['id']) ? (int) $payload['id'] : 0;
    if ($id > 0) {
        foreach ($templates as &$tpl) {
            if (($tpl['id'] ?? 0) === $id) {
                $tpl['name']  = $payload['name'] ?? $tpl['name'];
                $tpl['rules'] = $payload['rules'] ?? $tpl['rules'];
            }
        }
        unset($tpl);
    } else {
        $maxId = 0;
        foreach ($templates as $t) {
            $maxId = max($maxId, (int) ($t['id'] ?? 0));
        }
        $id          = $maxId + 1;
        $templates[] = [
            'id' => $id,
            'name' => $payload['name'] ?? '',
            'rules' => $payload['rules'] ?? [],
        ];
    }
    save_automation_templates($templates, $companyId);
    echo json_encode(['status' => 'ok', 'id' => $id]);
    exit;
}

if ($method === 'DELETE') {
    if (!is_company_admin($userId, $companyId) && !$isSuper) {
        jsonError('Forbidden', 403);
    }
    $id = isset($_GET['id']) ? (int) $_GET['id'] : 0;
    $templates = fetch_automation_templates($companyId);
    $templates = array_values(array_filter(
        $templates,
        function ($t) use ($id) {
            return ($t['id'] ?? 0) !== $id;
        }
    ));
    save_automation_templates($templates, $companyId);
    echo json_encode(['status' => 'ok']);
    exit;
}

jsonError('Method not allowed', 405);

