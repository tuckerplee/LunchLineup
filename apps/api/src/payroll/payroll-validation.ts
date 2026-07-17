import { BadRequestException } from '@nestjs/common';

import { parseUtcInstant } from '../time-cards/time-card-correction';

export const MAX_PAYROLL_HISTORY_PAGE_SIZE = 50;
export const MAX_PAYROLL_CARD_PAGE_SIZE = 250;
export const MAX_PAYROLL_REQUEST_ITEMS = 100;
export const MAX_PAYROLL_LOCK_ENTRIES = 5_000;
export const MAX_PAYROLL_EXPORT_LINE_PAGE_SIZE = 500;

export type PayrollDecisionValue = 'APPROVED' | 'REJECTED';

export function parseBoundedLimit(
    value: unknown,
    options: { field: string; defaultValue: number; maximum: number },
): number {
    if (value === undefined || value === null || value === '') return options.defaultValue;
    const normalized = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.trim() : '';
    if (!/^[0-9]+$/.test(normalized)) {
        throw new BadRequestException(`${options.field} must be a positive integer.`);
    }
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > options.maximum) {
        throw new BadRequestException(`${options.field} must be between 1 and ${options.maximum}.`);
    }
    return parsed;
}

export function parseOpaqueCursor(value: unknown, field: string): string | null {
    if (value === undefined || value === null) return null;
    return requiredId(value, field);
}

export function parseExpectedRevision(value: unknown, field = 'expectedRevision'): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new BadRequestException(`${field} must be a non-negative integer.`);
    }
    return Number(value);
}

export function parseAdoption(value: unknown): Array<{ id: string; expectedRevision: number }> {
    const body = requiredRecord(value, 'Adoption request is required.');
    const cards = requiredBoundedArray(body.cards, 'cards');
    const normalized = cards.map((entry, index) => {
        const card = requiredRecord(entry, `cards[${index}] is invalid.`);
        return {
            id: requiredId(card.id, `cards[${index}].id`),
            expectedRevision: parseExpectedRevision(card.expectedRevision, `cards[${index}].expectedRevision`),
        };
    });
    assertUnique(normalized.map((card) => card.id), 'cards must not contain duplicate IDs.');
    return normalized.sort((left, right) => compareText(left.id, right.id));
}

export function parseApprovalDecisions(value: unknown): Array<{
    timeCardId: string;
    expectedRevision: number;
    decision: PayrollDecisionValue;
    reason: string | null;
}> {
    const body = requiredRecord(value, 'Decision request is required.');
    const decisions = requiredBoundedArray(body.decisions, 'decisions');
    const normalized = decisions.map((entry, index) => {
        const decision = requiredRecord(entry, `decisions[${index}] is invalid.`);
        return {
            timeCardId: requiredId(decision.timeCardId, `decisions[${index}].timeCardId`),
            expectedRevision: parseExpectedRevision(
                decision.expectedRevision,
                `decisions[${index}].expectedRevision`,
            ),
            decision: parseDecision(decision.decision, `decisions[${index}].decision`),
            reason: optionalReason(decision.reason),
        };
    });
    assertUnique(
        normalized.map((decision) => `${decision.timeCardId}:${decision.expectedRevision}`),
        'decisions must not repeat a time-card revision.',
    );
    return normalized.sort((left, right) => compareText(left.timeCardId, right.timeCardId));
}

export function parseAmendment(value: unknown): {
    adjustmentPeriodId: string;
    replacementClockInAt: Date;
    replacementClockOutAt: Date;
    replacementBreakMinutes: number;
    reason: string;
} {
    const body = requiredRecord(value, 'Amendment request is required.');
    const replacementClockInAt = parseUtcInstant(body.replacementClockInAt, 'replacementClockInAt');
    const replacementClockOutAt = parseUtcInstant(body.replacementClockOutAt, 'replacementClockOutAt');
    const replacementBreakMinutes = parseUnsignedInteger(body.replacementBreakMinutes, 'replacementBreakMinutes');
    const grossMinutes = Math.floor((replacementClockOutAt.getTime() - replacementClockInAt.getTime()) / 60_000);
    if (grossMinutes <= 0 || replacementBreakMinutes >= grossMinutes) {
        throw new BadRequestException('Replacement payroll times and breaks are invalid.');
    }
    return {
        adjustmentPeriodId: requiredId(body.adjustmentPeriodId, 'adjustmentPeriodId'),
        replacementClockInAt,
        replacementClockOutAt,
        replacementBreakMinutes,
        reason: requiredReason(body.reason),
    };
}

export function parseAmendmentDecision(value: unknown): {
    decision: PayrollDecisionValue;
    reason: string | null;
} {
    const body = requiredRecord(value, 'Amendment decision is required.');
    return {
        decision: parseDecision(body.decision, 'decision'),
        reason: optionalReason(body.reason),
    };
}

export function requiredId(value: unknown, field: string): string {
    if (typeof value !== 'string') throw new BadRequestException(`${field} is required.`);
    const normalized = value.trim();
    if (!normalized || normalized.length > 200 || /[^\x20-\x7E]/.test(normalized)) {
        throw new BadRequestException(`${field} is invalid.`);
    }
    return normalized;
}

export function requiredReason(value: unknown): string {
    if (typeof value !== 'string') throw new BadRequestException('reason is required.');
    const normalized = value.trim();
    if (normalized.length < 5 || normalized.length > 500) {
        throw new BadRequestException('reason must contain between 5 and 500 characters.');
    }
    return normalized;
}

function optionalReason(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    return requiredReason(value);
}

function parseDecision(value: unknown, field: string): PayrollDecisionValue {
    if (value !== 'APPROVED' && value !== 'REJECTED') {
        throw new BadRequestException(`${field} must be APPROVED or REJECTED.`);
    }
    return value;
}

function parseUnsignedInteger(value: unknown, field: string): number {
    if (!Number.isSafeInteger(value) || Number(value) < 0) {
        throw new BadRequestException(`${field} must be a non-negative integer.`);
    }
    return Number(value);
}

function requiredBoundedArray(value: unknown, field: string): unknown[] {
    if (!Array.isArray(value) || value.length < 1 || value.length > MAX_PAYROLL_REQUEST_ITEMS) {
        throw new BadRequestException(`${field} must contain between 1 and ${MAX_PAYROLL_REQUEST_ITEMS} items.`);
    }
    return value;
}

function requiredRecord(value: unknown, message: string): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new BadRequestException(message);
    }
    return value as Record<string, unknown>;
}

function assertUnique(values: string[], message: string): void {
    if (new Set(values).size !== values.length) throw new BadRequestException(message);
}

function compareText(left: string, right: string): number {
    return left < right ? -1 : left > right ? 1 : 0;
}
