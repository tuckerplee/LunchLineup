export type TenantCreateInput = {
    name: string;
    slug?: string;
    planTier: string;
    status: string;
    ownerName: string;
    ownerEmail: string;
};

export type TenantCreatePayload = TenantCreateInput;

export type TenantEditInput = {
    name: string;
    slug: string;
};

export type TenantEditPayload = TenantEditInput;

export const TENANT_PLAN_EDIT_GUIDANCE =
    'Plan is read-only here. Use the tenant billing workflow so Stripe subscription and entitlement changes stay coordinated.';

export const TENANT_STATUS_EDIT_GUIDANCE =
    'Status is read-only here. Use the dedicated lifecycle actions below to suspend, activate, archive, restore, or permanently delete the tenant.';

export const TENANT_CREATE_CREDIT_GUIDANCE =
    'Tenant creation does not grant credits. Use Admin Credits after creation for audited grants or corrections. Paid subscriptions and credits are separate; plans never include recurring or unlimited credits.';

export const TENANT_CREDIT_EDIT_GUIDANCE =
    'Current wallet balance is read-only here. Use Admin Credits for audited grants or corrections. Paid subscriptions and credits are separate; plans never include recurring or unlimited credits.';

export function buildTenantCreatePayload(input: TenantCreateInput): TenantCreatePayload {
    return {
        name: input.name,
        slug: input.slug,
        planTier: input.planTier,
        status: input.status,
        ownerName: input.ownerName,
        ownerEmail: input.ownerEmail,
    };
}

export function buildTenantEditPayload(input: TenantEditInput): TenantEditPayload {
    return {
        name: input.name,
        slug: input.slug,
    };
}
