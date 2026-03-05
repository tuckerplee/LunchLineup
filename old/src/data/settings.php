<?php
declare(strict_types=1);

function getSetting(string $name, ?int $storeId = null, ?int $companyId = null): ?string
{
    $db = getDb();
    if ($storeId !== null) {
        $cid = $companyId ?? get_store_company_id($storeId);
        $stmt = $db->prepare("SELECT value FROM settings WHERE scope = 'store' AND company_id = ? AND store_id = ? AND name = ?");
        $stmt->execute([$cid, $storeId, $name]);
    } elseif ($companyId !== null) {
        $stmt = $db->prepare("SELECT value FROM settings WHERE scope = 'company' AND company_id = ? AND name = ?");
        $stmt->execute([$companyId, $name]);
    } else {
        $stmt = $db->prepare("SELECT value FROM settings WHERE scope = 'global' AND name = ?");
        $stmt->execute([$name]);
    }
    $value = $stmt->fetchColumn();
    return $value !== false ? $value : null;
}

function setSetting(string $name, string $value, ?int $storeId = null, ?int $companyId = null): void
{
    $db = getDb();
    if ($storeId !== null) {
        $cid = $companyId ?? get_store_company_id($storeId);
        $stmt = $db->prepare("REPLACE INTO settings (scope, store_id, company_id, name, value) VALUES ('store', ?, ?, ?, ?)");
        $stmt->execute([$storeId, $cid, $name, $value]);
    } elseif ($companyId !== null) {
        $stmt = $db->prepare("REPLACE INTO settings (scope, store_id, company_id, name, value) VALUES ('company', NULL, ?, ?, ?)");
        $stmt->execute([$companyId, $name, $value]);
    } else {
        $stmt = $db->prepare("REPLACE INTO settings (scope, store_id, company_id, name, value) VALUES ('global', NULL, NULL, ?, ?)");
        $stmt->execute([$name, $value]);
    }
    auditLog('save', 'setting');
}

function deleteSetting(string $name, ?int $storeId = null, ?int $companyId = null): void
{
    $db = getDb();
    if ($storeId !== null) {
        $cid = $companyId ?? get_store_company_id($storeId);
        $stmt = $db->prepare("DELETE FROM settings WHERE scope = 'store' AND company_id = ? AND store_id = ? AND name = ?");
        $stmt->execute([$cid, $storeId, $name]);
    } elseif ($companyId !== null) {
        $stmt = $db->prepare("DELETE FROM settings WHERE scope = 'company' AND company_id = ? AND name = ?");
        $stmt->execute([$companyId, $name]);
    } else {
        $stmt = $db->prepare("DELETE FROM settings WHERE scope = 'global' AND name = ?");
        $stmt->execute([$name]);
    }
    auditLog('delete', 'setting');
}

function save_break_settings(int $storeId, int $maxConcurrent, int $minSpacing, string $lunchStart, string $lunchEnd, int $companyId = 1): void
{
    setSetting('break_max_concurrent', (string) $maxConcurrent, $storeId, $companyId);
    setSetting('break_min_spacing', (string) $minSpacing, $storeId, $companyId);
    setSetting('lunch_window_start', $lunchStart, $storeId, $companyId);
    setSetting('lunch_window_end', $lunchEnd, $storeId, $companyId);
}

function fetch_break_template(int $companyId = 1): array
{
    $db = getDb();
    $stmt = $db->prepare(
        'SELECT break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration FROM break_templates WHERE company_id = ? LIMIT 1'
    );
    $stmt->execute([$companyId]);
    $row = $stmt->fetch(PDO::FETCH_ASSOC);
    if ($row === false) {
        $stmt = $db->query(
            'SELECT break1_offset, break1_duration, lunch_offset, lunch_duration, break2_offset, break2_duration FROM break_templates WHERE company_id IS NULL LIMIT 1'
        );
        $row = $stmt->fetch(PDO::FETCH_ASSOC);
    }
    if ($row === false) {
        $row = [
            'break1_offset' => 2,
            'break1_duration' => 10,
            'lunch_offset' => 4,
            'lunch_duration' => 60,
            'break2_offset' => 2,
            'break2_duration' => 10,
        ];
    }
    return [
        'break1Offset' => (int) $row['break1_offset'],
        'lunchOffset' => (int) $row['lunch_offset'],
        'break2Offset' => (int) $row['break2_offset'],
        'break1Duration' => (int) $row['break1_duration'],
        'lunchDuration' => (int) $row['lunch_duration'],
        'break2Duration' => (int) $row['break2_duration'],
    ];
}

function fetch_break_policy(int $storeId, int $companyId = 1): array
{
    $template = fetch_break_template($companyId);

    $policy = [
        'maxConcurrent'    => (int) (getSetting('break_max_concurrent', $storeId, $companyId) ?? 1),
        'minSpacing'       => (int) (getSetting('break_min_spacing', $storeId, $companyId) ?? 60),
        'break1Duration'   => (int) (getSetting('break1_duration', $storeId, $companyId) ?? $template['break1Duration']),
        'break2Duration'   => (int) (getSetting('break2_duration', $storeId, $companyId) ?? $template['break2Duration']),
        'lunchDuration'    => (int) (getSetting('lunch_duration', $storeId, $companyId) ?? $template['lunchDuration']),
        'lunchWindowStart' => (string) (getSetting('lunch_window_start', $storeId, $companyId) ?? '11:00'),
        'lunchWindowEnd'   => (string) (getSetting('lunch_window_end', $storeId, $companyId) ?? '14:00'),
        'break1Percent'    => (float) (getSetting('break1_percent', $storeId, $companyId) ?? 0.25),
        'lunchPercent'     => (float) (getSetting('lunch_percent', $storeId, $companyId) ?? 0.5),
        'break2Percent'    => (float) (getSetting('break2_percent', $storeId, $companyId) ?? 0.75),
        'break1Offset'     => $template['break1Offset'],
        'lunchOffset'      => $template['lunchOffset'],
        'break2Offset'     => $template['break2Offset'],
    ];

    return $policy;
}

function fetch_automation_templates(int $companyId): array
{
    $raw = getSetting('automation_templates', null, $companyId);
    $templates = json_decode($raw ?? '', true);
    return is_array($templates) ? $templates : [];
}

function save_automation_templates(array $templates, int $companyId): void
{
    setSetting('automation_templates', json_encode($templates), null, $companyId);
}


