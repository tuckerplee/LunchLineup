export type RoleDeletionTarget = {
    name: string;
    userCount: number;
};

export type RoleDeletionConfirmation = {
    title: string;
    description: string;
    confirmLabel: string;
    expectedName: string;
    blocked: boolean;
};

export function buildRoleDeletionConfirmation(role: RoleDeletionTarget): RoleDeletionConfirmation {
    const assignmentLabel = `${role.userCount} ${role.userCount === 1 ? 'assignment' : 'assignments'}`;
    return {
        title: `Delete ${role.name}?`,
        description: role.userCount > 0
            ? `${role.name} has ${assignmentLabel}. Reassign those staff members before deleting this role.`
            : `${role.name} has ${assignmentLabel}. Type the role name exactly to permanently delete it.`,
        confirmLabel: 'Delete role',
        expectedName: role.name,
        blocked: role.userCount > 0,
    };
}

export function canConfirmRoleDeletion(
    confirmation: RoleDeletionConfirmation,
    enteredName: string,
): boolean {
    return !confirmation.blocked && enteredName === confirmation.expectedName;
}
