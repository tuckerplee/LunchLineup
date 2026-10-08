export type CreditGrantEstimate = {
    repaidDebt: number;
    spendableAmount: number;
    newBalance: number;
    debtAfter: number;
};

export function isCreditBalanceValue(value: unknown): value is number {
    return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

// A loaded-snapshot estimate only. The server locks current balances and debt;
// this result must never authorize a grant or validate its acknowledgement.
export function estimateCreditGrant(
    wallet: unknown, debt: unknown, amount: unknown,
): CreditGrantEstimate | null {
    if (!isCreditBalanceValue(wallet) || !isCreditBalanceValue(debt)
        || !isCreditBalanceValue(amount) || amount === 0) return null;
    const repaidDebt = Math.min(debt, amount);
    const spendableAmount = amount - repaidDebt;
    const newBalance = wallet + spendableAmount;
    if (!Number.isSafeInteger(newBalance)) return null;
    return { repaidDebt, spendableAmount, newBalance, debtAfter: debt - repaidDebt };
}

export function creditGrantConfirmation(
    tenantName: string, amount: number, estimate: CreditGrantEstimate | null,
): string {
    const format = (value: number) => new Intl.NumberFormat('en-US').format(value);
    const prefix = `Grant ${format(amount)} credits to ${tenantName}?`;
    if (!estimate) {
        return `${prefix} A balance estimate is unavailable; refresh balances for debt details. `
            + 'Outstanding debt is repaid first, and the server determines the final balances.';
    }
    return `${prefix} Estimated debt repayment: ${format(estimate.repaidDebt)} credits. `
        + `Estimated spendable balance: ${format(estimate.newBalance)} credits. `
        + `Estimated remaining debt: ${format(estimate.debtAfter)} credits. `
        + 'Estimates use loaded balances; the server settles against current balances.';
}
