<?php

declare(strict_types=1);

require_once __DIR__ . '/data/users.php';
require_once __DIR__ . '/data/roles.php';
require_once __DIR__ . '/StaffService.php';

class UserService
{
    private StaffService $staffService;

    public function __construct(?StaffService $staffService = null)
    {
        $this->staffService = $staffService ?? new StaffService();
    }

    public function save(array $payload): int
    {
        $data  = $payload;
        $roles = $this->normalizeRoles($payload['roles'] ?? []);
        unset($data['storeIds'], $data['roles']);
        $isAdmin        = $payload['isAdmin']
            ?? (!empty($payload['id'])
                ? fetch_user_is_admin((int) $payload['id'], (int) ($payload['companyId'] ?? 0))
                : false);
        $data['isAdmin'] = $isAdmin;
        $data['isStaff'] = in_array('staff', $roles, true);
        $id              = saveUser($data);
        $storeIds        = $payload['storeIds'] ?? [$payload['homeStoreId']];
        if (!in_array($payload['homeStoreId'], $storeIds, true)) {
            $storeIds[] = (int) $payload['homeStoreId'];
        }
        $this->assignRoles($id, $storeIds, $roles);
        return $id;
    }

    /**
     * @param array<int> $storeIds
     * @param array<int,string> $roles
     */
    public function assignRoles(int $userId, array $storeIds, array $roles): void
    {
        sync_user_roles($userId, $storeIds, $roles);
    }

    public function setAdmin(int $userId, int $companyId, bool $isAdmin): void
    {
        $this->staffService->setAdmin($userId, $isAdmin);
        if ($companyId === 0) {
            return;
        }
        if ($isAdmin) {
            assign_user_company_role($userId, $companyId, 'company_admin');
        } else {
            remove_user_company_role($userId, $companyId, 'company_admin');
        }
    }

    private function normalizeRoles($rolesInput): array
    {
        $roles = [];
        if (is_array($rolesInput)) {
            foreach ($rolesInput as $key => $value) {
                if (is_int($key)) {
                    $role    = $value;
                    $enabled = true;
                } else {
                    $role    = $key;
                    $enabled = (bool) $value;
                }
                if ($enabled && in_array($role, ['staff', 'schedule', 'chores'], true)) {
                    $roles[] = $role;
                }
            }
            $roles = array_values(array_unique($roles));
        }
        return $roles;
    }
}
