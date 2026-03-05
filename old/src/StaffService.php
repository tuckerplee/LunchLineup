<?php

declare(strict_types=1);

require_once __DIR__ . '/data/staff.php';

class StaffService
{
    public function save(array $staff): int
    {
        return save_staff_member($staff);
    }

    public function setAdmin(int $staffId, bool $isAdmin): void
    {
        $db  = getDb();
        $col = staff_admin_column();
        if ($col === '') {
            return;
        }
        $stmt = $db->prepare("UPDATE staff SET {$col} = ? WHERE id = ?");
        $stmt->execute([$isAdmin ? 1 : 0, $staffId]);
    }
}
