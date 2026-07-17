export const MAX_AVAILABILITY_PDF_BYTES = 5 * 1024 * 1024;
export const AVAILABILITY_IMPORT_POLL_INTERVAL_MS = 1_500;
export const MAX_AVAILABILITY_IMPORT_POLLS = 40;
const STAFF_IDENTITY_PATTERN = /^[A-Za-z0-9._:@+-]{1,128}$/;

export type AvailabilityPdfCandidate = {
    name: string;
    size: number;
    type: string;
};

export type AvailabilityPdfImportAttempt<TFile extends AvailabilityPdfCandidate = File> = {
    file: TFile;
    idempotencyKey: string;
    staffIdentity: string;
};

export type AvailabilityImportRequestFields = {
    staffIdentity: string;
};

export type AvailabilityImportStatus =
    | 'PENDING'
    | 'QUEUED'
    | 'RUNNING'
    | 'RETRYING'
    | 'SUCCEEDED'
    | 'FAILED'
    | 'DEAD_LETTERED'
    | 'CANCELLED';

export type ImportedAvailabilityWindow = {
    locationId: string | null;
    dayOfWeek: number;
    startTimeMinutes: number;
    endTimeMinutes: number;
};

export type AvailabilityImportSettlement = {
    chargedCredits: number;
    refundedCredits: number;
    pending: boolean;
};

export type AvailabilityImportJob = {
    id: string;
    userId: string;
    status: AvailabilityImportStatus;
    parsedAvailability: ImportedAvailabilityWindow[] | null;
    settlement: AvailabilityImportSettlement;
};

export type AvailabilityImportStatusView = {
    label: string;
    detail: string;
    creditDetail: string;
    tone: 'neutral' | 'progress' | 'success' | 'danger';
};

const AVAILABILITY_IMPORT_STATUSES = new Set<AvailabilityImportStatus>([
    'PENDING',
    'QUEUED',
    'RUNNING',
    'RETRYING',
    'SUCCEEDED',
    'FAILED',
    'DEAD_LETTERED',
    'CANCELLED',
]);

const TERMINAL_IMPORT_STATUSES = new Set<AvailabilityImportStatus>([
    'SUCCEEDED',
    'FAILED',
    'DEAD_LETTERED',
    'CANCELLED',
]);


const STATUS_VIEWS: Record<AvailabilityImportStatus, Omit<AvailabilityImportStatusView, 'creditDetail'>> = {
    PENDING: {
        label: 'Pending',
        detail: 'The upload was accepted and is waiting for processing.',
        tone: 'neutral',
    },
    QUEUED: {
        label: 'Pending (queued)',
        detail: 'The import is queued for the availability parser.',
        tone: 'neutral',
    },
    RUNNING: {
        label: 'Running',
        detail: 'The availability PDF is being parsed.',
        tone: 'progress',
    },
    RETRYING: {
        label: 'Running (retrying)',
        detail: 'Processing is retrying after a temporary failure.',
        tone: 'progress',
    },
    SUCCEEDED: {
        label: 'Succeeded',
        detail: 'The PDF was parsed. Review the result before applying it.',
        tone: 'success',
    },
    FAILED: {
        label: 'Failed',
        detail: 'The PDF could not be imported. Select a PDF to start a new attempt.',
        tone: 'danger',
    },
    DEAD_LETTERED: {
        label: 'Dead-lettered',
        detail: 'Processing stopped after repeated failures. Select a PDF to start a new attempt.',
        tone: 'danger',
    },
    CANCELLED: {
        label: 'Cancelled',
        detail: 'The import was cancelled before availability was applied.',
        tone: 'danger',
    },
};

export function validateAvailabilityPdfFile(file: AvailabilityPdfCandidate | null): string | null {
    if (!file) return 'Select a PDF file.';
    if (!file.name.trim().toLowerCase().endsWith('.pdf') || file.type.trim().toLowerCase() !== 'application/pdf') {
        return 'Select a PDF file only.';
    }
    if (!Number.isSafeInteger(file.size) || file.size <= 0) return 'The selected PDF is empty or invalid.';
    if (file.size > MAX_AVAILABILITY_PDF_BYTES) return 'The selected PDF must be 5 MiB or smaller.';
    return null;
}

export function validateAvailabilityImportStaffIdentity(value: string): string | null {
    const identity = value.trim();
    if (!identity) return 'Employee or staff ID is required.';
    if (!STAFF_IDENTITY_PATTERN.test(identity)) {
        return 'Employee or staff ID must be 1 to 128 letters, numbers, or . _ : @ + - characters.';
    }
    return null;
}

export function normalizeAvailabilityImportStaffIdentity(value: string): string {
    const validationError = validateAvailabilityImportStaffIdentity(value);
    if (validationError) throw new Error(validationError);
    const identity = value.trim();
    return identity.toLowerCase();
}

export function createAvailabilityPdfImportAttempt<TFile extends AvailabilityPdfCandidate>(
    file: TFile,
    staffIdentity: string,
    keyFactory: () => string = () => globalThis.crypto.randomUUID(),
): AvailabilityPdfImportAttempt<TFile> {
    const validationError = validateAvailabilityPdfFile(file);
    if (validationError) throw new Error(validationError);
    const idempotencyKey = keyFactory().trim();
    if (!idempotencyKey) throw new Error('Unable to create a stable import attempt.');
    return {
        file,
        idempotencyKey,
        staffIdentity: normalizeAvailabilityImportStaffIdentity(staffIdentity),
    };
}

export function updateAvailabilityPdfImportAttemptIdentity<TFile extends AvailabilityPdfCandidate>(
    attempt: AvailabilityPdfImportAttempt<TFile>,
    staffIdentity: string,
    keyFactory: () => string = () => globalThis.crypto.randomUUID(),
): AvailabilityPdfImportAttempt<TFile> {
    const normalizedIdentity = normalizeAvailabilityImportStaffIdentity(staffIdentity);
    if (normalizedIdentity === attempt.staffIdentity) return attempt;
    return createAvailabilityPdfImportAttempt(attempt.file, staffIdentity, keyFactory);
}

export function availabilityImportRequestFields<TFile extends AvailabilityPdfCandidate>(
    attempt: AvailabilityPdfImportAttempt<TFile>,
): AvailabilityImportRequestFields {
    return { staffIdentity: attempt.staffIdentity };
}

export function isAvailabilityImportTerminal(status: AvailabilityImportStatus): boolean {
    return TERMINAL_IMPORT_STATUSES.has(status);
}

export function availabilityImportStatusView(
    status: AvailabilityImportStatus,
    settlement: AvailabilityImportSettlement,
): AvailabilityImportStatusView {
    return {
        ...STATUS_VIEWS[status],
        creditDetail: availabilityImportCreditDetail(status, settlement),
    };
}

export function parseSchedulingCreditCost(payload: unknown): number {
    if (!isRecord(payload) || !isRecord(payload.features) || !isRecord(payload.features.scheduling)) {
        throw new Error('The availability import credit cost is unavailable.');
    }
    const creditCost = payload.features.scheduling.creditCost;
    if (!isPositiveSafeInteger(creditCost)) {
        throw new Error('The availability import credit cost is unavailable.');
    }
    return creditCost;
}

export function assertAvailabilityImportAcceptedCost(
    job: AvailabilityImportJob,
    expectedCreditCost: number,
): void {
    if (!isPositiveSafeInteger(expectedCreditCost) || job.settlement.chargedCredits !== expectedCreditCost) {
        throw new Error('The availability import charge did not match the confirmed credit cost.');
    }
}

export function parseAvailabilityImportJob(payload: unknown): AvailabilityImportJob {
    if (!isRecord(payload)) throw new Error('The availability import returned an invalid response.');
    const id = nonEmptyString(payload.id);
    const userId = nonEmptyString(payload.userId);
    const status = payload.status;
    if (!id || !userId || typeof status !== 'string' || !AVAILABILITY_IMPORT_STATUSES.has(status as AvailabilityImportStatus)) {
        throw new Error('The availability import returned an invalid response.');
    }
    const normalizedStatus = status as AvailabilityImportStatus;
    const settlement = parseSettlement(payload.settlement);
    if (
        (normalizedStatus === 'PENDING'
            || normalizedStatus === 'QUEUED'
            || normalizedStatus === 'RUNNING'
            || normalizedStatus === 'RETRYING'
            || normalizedStatus === 'SUCCEEDED')
        && settlement.chargedCredits <= 0
    ) {
        throw new Error('The availability import returned an invalid response.');
    }

    let parsedAvailability: ImportedAvailabilityWindow[] | null = null;
    if (payload.parsedAvailability !== null && payload.parsedAvailability !== undefined) {
        if (normalizedStatus !== 'SUCCEEDED' || !Array.isArray(payload.parsedAvailability)) {
            throw new Error('The availability import returned an invalid response.');
        }
        parsedAvailability = parseAvailabilityRows(payload.parsedAvailability);
    }

    return {
        id,
        userId,
        status: normalizedStatus,
        parsedAvailability,
        settlement,
    };
}

function availabilityImportCreditDetail(
    status: AvailabilityImportStatus,
    settlement: AvailabilityImportSettlement,
): string {
    const { chargedCredits, refundedCredits } = settlement;
    const refundTerminal = status === 'FAILED' || status === 'DEAD_LETTERED' || status === 'CANCELLED';
    if (refundTerminal) {
        if (chargedCredits > 0 && refundedCredits === chargedCredits) {
            const credits = paidCredits(chargedCredits);
            return `${credits} ${chargedCredits === 1 ? 'was' : 'were'} refunded for this import.`;
        }
        return 'Refund settlement is pending or could not be verified.';
    }
    if (status === 'SUCCEEDED') {
        if (chargedCredits > 0 && refundedCredits === 0) {
            const credits = paidCredits(chargedCredits);
            return `${credits} ${chargedCredits === 1 ? 'was' : 'were'} charged for this completed import.`;
        }
        return 'Credit settlement could not be verified.';
    }
    if (chargedCredits > 0) {
        const credits = paidCredits(chargedCredits);
        return `${credits} ${chargedCredits === 1 ? 'was' : 'were'} charged. Final settlement is pending.`;
    }
    return 'Credit settlement is pending or could not be verified.';
}

function paidCredits(count: number): string {
    return `${count} paid ${count === 1 ? 'credit' : 'credits'}`;
}

function parseSettlement(value: unknown): AvailabilityImportSettlement {
    if (
        !isRecord(value)
        || !isBoundedInteger(value.chargedCredits, 0, Number.MAX_SAFE_INTEGER)
        || !isBoundedInteger(value.refundedCredits, 0, Number.MAX_SAFE_INTEGER)
        || value.refundedCredits > value.chargedCredits
        || (value.pending !== undefined && typeof value.pending !== 'boolean')
    ) {
        throw new Error('The availability import returned an invalid response.');
    }
    return {
        chargedCredits: value.chargedCredits,
        refundedCredits: value.refundedCredits,
        pending: value.pending === true,
    };
}
function parseAvailabilityRows(rows: unknown[]): ImportedAvailabilityWindow[] {
    if (rows.length < 1 || rows.length > 21) {
        throw new Error('The availability import returned an invalid response.');
    }
    const normalized: ImportedAvailabilityWindow[] = [];
    const seen = new Set<string>();
    for (const row of rows) {
        if (!isRecord(row)) throw new Error('The availability import returned an invalid response.');
        const locationId = row.locationId;
        const dayOfWeek = row.dayOfWeek;
        const startTimeMinutes = row.startTimeMinutes;
        const endTimeMinutes = row.endTimeMinutes;
        if (
            (locationId !== null && nonEmptyString(locationId) === null)
            || !isBoundedInteger(dayOfWeek, 0, 6)
            || !isBoundedInteger(startTimeMinutes, 0, 1_439)
            || !isBoundedInteger(endTimeMinutes, 0, 1_439)
            || startTimeMinutes === endTimeMinutes
        ) {
            throw new Error('The availability import returned an invalid response.');
        }
        const key = `${locationId ?? ''}:${dayOfWeek}:${startTimeMinutes}:${endTimeMinutes}`;
        if (seen.has(key)) throw new Error('The availability import returned duplicate availability.');
        seen.add(key);
        normalized.push({
            locationId: locationId === null ? null : locationId as string,
            dayOfWeek,
            startTimeMinutes,
            endTimeMinutes,
        });
    }
    return normalized;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function nonEmptyString(value: unknown): string | null {
    return typeof value === 'string' && value.trim() ? value : null;
}

function isBoundedInteger(value: unknown, minimum: number, maximum: number): value is number {
    return typeof value === 'number'
        && Number.isSafeInteger(value)
        && value >= minimum
        && value <= maximum;
}

function isPositiveSafeInteger(value: unknown): value is number {
    return isBoundedInteger(value, 1, Number.MAX_SAFE_INTEGER);
}
