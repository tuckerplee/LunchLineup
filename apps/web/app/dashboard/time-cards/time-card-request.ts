export type EmployeeTimeCard = {
    userId: string;
};

export type TimeCardView = 'mine' | 'team';

export type TimeCardWriteTarget = {
    view: TimeCardView;
    currentUserId: string;
    selectedTeamUserId: string;
    selectedLocationId: string;
    canReadLocations: boolean;
};

export function isTimeCardForEmployee(
    card: EmployeeTimeCard | null | undefined,
    selectedUserId: string,
): card is EmployeeTimeCard {
    return Boolean(card && card.userId === selectedUserId);
}

export function selectedTimeCardUserId(target: Pick<TimeCardWriteTarget, 'view' | 'currentUserId' | 'selectedTeamUserId'>): string {
    return target.view === 'mine' ? target.currentUserId : target.selectedTeamUserId;
}

export function isClockInTargetExplicit(target: TimeCardWriteTarget): boolean {
    if (!selectedTimeCardUserId(target)) return false;
    if (target.view === 'team' && !target.selectedTeamUserId) return false;
    return !(target.view === 'team' || target.canReadLocations) || Boolean(target.selectedLocationId);
}

export function timeCardMutationLabel(
    action: 'clock-in' | 'clock-out',
    targetName: string,
    locationName?: string,
): string {
    const verb = action === 'clock-in' ? 'Clock in' : 'Clock out';
    const location = locationName ? `${action === 'clock-in' ? ' at ' : ' from '}${locationName}` : '';
    return `${verb} ${targetName}${location}`;
}

export class ClockInRequestKey {
    private key: string | null = null;

    constructor(private readonly createKey: () => string = () => crypto.randomUUID()) {}

    current(): string {
        this.key ??= this.createKey();
        return this.key;
    }

    reset(): void {
        this.key = null;
    }
}
