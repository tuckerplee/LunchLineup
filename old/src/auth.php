<?php

declare(strict_types=1);

/**
 * Send a standard JSON forbidden response and terminate execution.
 */
function authForbidden(): void
{
    http_response_code(403);
    echo json_encode(['status' => 'error', 'message' => 'Forbidden']);
    if (defined('TESTING') && TESTING) {
        throw new RuntimeException('Forbidden');
    }
    exit;
}

/**
 * Ensure the authenticated user is a company administrator or super admin.
 *
 * @param array $auth      Authentication payload containing user information.
 * @param int   $companyId Target company identifier.
 */
function require_company_admin(array $auth, int $companyId): void
{
    $userId = (int) ($auth['sub'] ?? 0);
    if (empty($auth['isSuperAdmin']) && ($companyId === 0 || !is_company_admin($userId, $companyId))) {
        authForbidden();
    }
}

/**
 * Ensure the authenticated user has access to the given store.
 *
 * @param array $auth    Authentication payload containing user information.
 * @param int   $storeId Target store identifier.
 * @return int          The company identifier owning the store.
 */
function require_store_access(array $auth, int $storeId): int
{
    $userId    = (int) ($auth['sub'] ?? 0);
    $companyId = get_store_company_id($storeId);
    $hasStore  = in_array($storeId, $auth['stores'] ?? [], true);
    if ($companyId === 0 || (!$hasStore && empty($auth['isSuperAdmin']) && !is_company_admin($userId, $companyId))) {
        authForbidden();
    }
    return $companyId;
}
