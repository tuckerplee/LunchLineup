export type StaffOnboardingMethod = 'email' | 'pin';

export type StaffInvitationPayload = {
    name: string;
    email?: string;
    username?: string;
    pin?: string;
    roleId?: string;
};

type StaffInvitationDraft = {
    method: StaffOnboardingMethod;
    name: string;
    email: string;
    username: string;
    pin: string;
    roleId: string;
};

type RandomValueFiller = (values: Uint32Array) => Uint32Array;

const PIN_RANGE = 900_000;
const UINT32_RANGE = 0x1_0000_0000;
const MAX_UNBIASED_VALUE = Math.floor(UINT32_RANGE / PIN_RANGE) * PIN_RANGE;

export function emailInvitationEnabledFromEnv(value: string | undefined): boolean {
    return value?.trim().toLowerCase() === 'true';
}

export function resolveEmailInvitationAvailability(
    catalogValue: unknown,
    environmentEnabled: boolean,
): boolean {
    return environmentEnabled && catalogValue !== false;
}

export function buildStaffInvitationPayload(draft: StaffInvitationDraft): StaffInvitationPayload {
    const payload: StaffInvitationPayload = { name: draft.name.trim() };
    const roleId = draft.roleId.trim();
    if (roleId) payload.roleId = roleId;

    if (draft.method === 'email') {
        payload.email = draft.email.trim();
        return payload;
    }

    payload.username = draft.username.trim();
    const pin = draft.pin.trim();
    if (pin) payload.pin = pin;
    return payload;
}

export function generateTemporaryPin(
    fillRandomValues: RandomValueFiller = (values) => crypto.getRandomValues(values),
): string {
    const values = new Uint32Array(1);
    do {
        fillRandomValues(values);
    } while ((values[0] ?? 0) >= MAX_UNBIASED_VALUE);

    return String(100_000 + ((values[0] ?? 0) % PIN_RANGE));
}

export function sameRoleSelection(left: readonly string[], right: readonly string[]): boolean {
    if (left.length !== right.length) return false;
    const orderedLeft = [...left].sort();
    const orderedRight = [...right].sort();
    return orderedLeft.every((roleId, index) => roleId === orderedRight[index]);
}
