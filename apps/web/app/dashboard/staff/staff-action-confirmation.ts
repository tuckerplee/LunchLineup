export type StaffAction = 'reset-pin' | 'remove';

type StaffActionTarget = {
    name: string;
    username?: string;
};

export type StaffActionConfirmation = {
    title: string;
    description: string;
    confirmLabel: string;
};

export function buildStaffActionConfirmation(
    action: StaffAction,
    user: StaffActionTarget,
): StaffActionConfirmation {
    const identity = user.username ? `${user.name} (${user.username})` : user.name;

    if (action === 'reset-pin') {
        return {
            title: `Reset PIN for ${user.name}?`,
            description: `${identity} will be signed out of PIN access and must use the new temporary PIN before continuing.`,
            confirmLabel: 'Reset PIN',
        };
    }

    return {
        title: `Permanently remove ${user.name}?`,
        description: `${identity} will immediately lose access. Removal anonymizes identity and clears editable assignments; it cannot be undone. Use Deactivate employee to preserve identity and history.`,
        confirmLabel: 'Remove permanently',
    };
}
