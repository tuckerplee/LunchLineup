export enum PlanTier {
    BASIC = 'BASIC',
    PRO = 'PRO',
    ENTERPRISE = 'ENTERPRISE',
}

export interface PlanLimits {
    maxLocations: number;
    maxStaffPerLocation: number;
    maxApiRequestsPerMonth: number;
    features: string[];
}

export const PLAN_CONFIG: Record<PlanTier, PlanLimits> = {
    [PlanTier.BASIC]: {
        maxLocations: 1,
        maxStaffPerLocation: 10,
        maxApiRequestsPerMonth: 1000,
        features: ['scheduling', 'basic-insights'],
    },
    [PlanTier.PRO]: {
        maxLocations: 5,
        maxStaffPerLocation: 50,
        maxApiRequestsPerMonth: 10000,
        features: ['scheduling', 'advanced-insights', 'webhooks', 'api-access'],
    },
    [PlanTier.ENTERPRISE]: {
        maxLocations: 999,
        maxStaffPerLocation: 999,
        maxApiRequestsPerMonth: 1000000,
        features: ['scheduling', 'advanced-insights', 'webhooks', 'api-access', 'dedicated-support', 'custom-branding'],
    },
};
