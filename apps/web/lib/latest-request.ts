export type RequestTicket<Scope> = Readonly<{
    generation: number;
    scope: Scope;
}>;

export type LatestRequestGate<Scope> = {
    begin(scope: Scope): RequestTicket<Scope>;
    invalidate(): void;
    isLatest(ticket: RequestTicket<Scope>): boolean;
};

export function createLatestRequestGate<Scope>(): LatestRequestGate<Scope> {
    let generation = 0;

    return {
        begin(scope) {
            generation += 1;
            return { generation, scope };
        },
        invalidate() {
            generation += 1;
        },
        isLatest(ticket) {
            return ticket.generation === generation;
        },
    };
}
