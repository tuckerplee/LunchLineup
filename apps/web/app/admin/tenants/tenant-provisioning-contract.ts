export type TenantCreatePlan = 'FREE' | 'STARTER' | 'GROWTH' | 'ENTERPRISE';
export type TenantCreateStatus = 'TRIAL' | 'ACTIVE';

export function startingStatusForPlan(planTier: TenantCreatePlan): TenantCreateStatus {
    return planTier === 'FREE' ? 'ACTIVE' : 'TRIAL';
}

export function tenantProvisioningDescription(planTier: TenantCreatePlan): string {
    if (planTier === 'FREE') {
        return 'FREE workspaces start active with free-tier entitlements.';
    }
    return 'Paid plans start in a bounded trial (14 days by default). ACTIVE requires verified billing after creation.';
}
