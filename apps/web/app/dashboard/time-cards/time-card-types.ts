export type TimeCardsWorkspaceProps = {
    canManageTeam: boolean;
    canReadLocations: boolean;
    canWriteTimeCards: boolean;
    currentUserId: string;
};

export type StaffMember = {
    id: string;
    name: string;
    role: string;
};

export type TimeCardLocation = {
    id: string;
    name: string;
};

export type LocationPage = {
    data?: TimeCardLocation[];
    pagination?: { hasMore?: boolean; nextCursor?: string | null };
};

export type TimeCardBreak = {
    id: string;
    startAt: string;
    endAt: string;
};

export type TimeCard = {
    id: string;
    userId: string;
    locationId?: string | null;
    clockInAt: string;
    clockOutAt?: string | null;
    breakMinutes: number;
    status: 'OPEN' | 'CLOSED' | 'VOID';
    grossMinutes: number;
    workedMinutes: number;
    notes?: string | null;
    updatedAt: string;
    displayTimeZone: string;
    breaks?: TimeCardBreak[];
    user?: { id: string; name: string; username?: string | null; role: string };
    location?: { id: string; name: string; timezone: string } | null;
};

export type TimeCardPage = {
    data?: TimeCard[];
    pagination?: { nextCursor?: string | null };
};
