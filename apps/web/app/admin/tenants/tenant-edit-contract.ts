export type TenantEditInput = {
    name: string;
    slug: string;
    usageCredits: number;
};

export type TenantEditPayload = TenantEditInput;

export const TENANT_PLAN_EDIT_GUIDANCE =
    'Plan is read-only here. Use the tenant billing workflow so Stripe subscription and entitlement changes stay coordinated.';

export const TENANT_STATUS_EDIT_GUIDANCE =
    'Status is read-only here. Use the dedicated lifecycle actions below to suspend, activate, archive, restore, or permanently delete the tenant.';

export function buildTenantEditPayload(input: TenantEditInput): TenantEditPayload {
    return {
        name: input.name,
        slug: input.slug,
        usageCredits: input.usageCredits,
    };
}
