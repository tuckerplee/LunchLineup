export type CreditReadLane = 'replacement' | 'tenants' | 'history';
export type CreditReadTicket = Readonly<{
    visit: number;
    epoch: number;
    sequence: number;
    lane: CreditReadLane;
    query: string;
    cursor: string | null;
}>;
export type CreditReadPending = {
    replacement: boolean;
    tenants: boolean;
    history: boolean;
    ready: boolean;
};
export type CreditReadCursors = { tenants: string | null; history: string | null };

// Request ownership is synchronous; React state is only a rendered snapshot.
// A replacement invalidates both append lanes. Current independent appends do
// not invalidate each other, and accepted pages retain FIFO publication rights
// within their epoch even after a later same-lane page starts.
export function createCreditReadOwner() {
    let active = false, visit = 0, epoch = 0, sequence = 0, query = '', ready = false;
    let cursors: CreditReadCursors = { tenants: null, history: null };
    let tickets: Record<CreditReadLane, CreditReadTicket | null> = { replacement: null, tenants: null, history: null };
    let pending: Record<CreditReadLane, boolean> = { replacement: false, tenants: false, history: false };
    const accepted = new WeakSet<CreditReadTicket>();
    const live = (ticket: CreditReadTicket) => active && ticket.visit === visit && ticket.epoch === epoch;
    const owns = (ticket: CreditReadTicket) => live(ticket) && tickets[ticket.lane] === ticket;
    function invalidate() {
        epoch += 1; ready = false; cursors = { tenants: null, history: null };
        tickets = { replacement: null, tenants: null, history: null };
        pending = { replacement: false, tenants: false, history: false };
    }
    function issue(lane: CreditReadLane, cursor: string | null): CreditReadTicket {
        const ticket = Object.freeze({ visit, epoch, sequence: ++sequence, lane, query, cursor });
        tickets[lane] = ticket; pending[lane] = true; return ticket;
    }
    return {
        activate() { visit += 1; active = true; invalidate(); },
        deactivate() { active = false; invalidate(); },
        visit: () => visit,
        isActiveVisit: (candidate: number) => active && candidate === visit,
        currentQuery: () => query,
        beginReplacement(search = query): CreditReadTicket | null {
            if (!active) return null;
            query = search.trim(); invalidate(); return issue('replacement', null);
        },
        beginAppend(lane: 'tenants' | 'history', cursor: string | null | undefined): CreditReadTicket | null {
            if (!active || !ready || pending.replacement || pending[lane] || !cursor || cursor !== cursors[lane]) return null;
            return issue(lane, cursor);
        },
        owns,
        accept(ticket: CreditReadTicket, next: CreditReadCursors) {
            if (!owns(ticket) || !pending[ticket.lane]) return false;
            if (ticket.lane === 'replacement') { cursors = { ...next }; ready = true; }
            else cursors[ticket.lane] = next[ticket.lane];
            accepted.add(ticket); return true;
        },
        canPublish: (ticket: CreditReadTicket) => live(ticket) && accepted.has(ticket),
        finish(ticket: CreditReadTicket) {
            if (!owns(ticket) || !pending[ticket.lane]) return false;
            pending[ticket.lane] = false; return true;
        },
        snapshot: (): CreditReadPending => ({ ...pending, ready }),
    };
}
