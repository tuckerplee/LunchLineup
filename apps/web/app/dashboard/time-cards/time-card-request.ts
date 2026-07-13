export type EmployeeTimeCard = {
    userId: string;
};

export function isTimeCardForEmployee(
    card: EmployeeTimeCard | null | undefined,
    selectedUserId: string,
): card is EmployeeTimeCard {
    return Boolean(card && card.userId === selectedUserId);
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
