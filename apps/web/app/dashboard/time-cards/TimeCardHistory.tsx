import { formatTimeCardDuration, formatTimeCardTimestamp } from './time-card-format';
import type { TimeCard } from './time-card-types';

type TimeCardHistoryProps = {
    cards: TimeCard[];
    canManageTeam: boolean;
    canWriteTimeCards: boolean;
    isMoreCardsLoading: boolean;
    nextCardsCursor: string | null;
    selectedStaffName: string;
    onCorrect: (card: TimeCard) => void;
    onLoadEarlier: () => void;
};

export function TimeCardHistory({
    cards,
    canManageTeam,
    canWriteTimeCards,
    isMoreCardsLoading,
    nextCardsCursor,
    selectedStaffName,
    onCorrect,
    onLoadEarlier,
}: TimeCardHistoryProps) {
    const canCorrect = canManageTeam && canWriteTimeCards;

    return (
        <section
            className="surface-card"
            style={{ padding: '1rem', overflowX: 'auto' }}
            tabIndex={0}
            aria-label="Scrollable time card history"
        >
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: '0.8rem', alignItems: 'center', marginBottom: '0.75rem' }}>
                <div>
                    <div className="workspace-kicker">History</div>
                    <h2 style={{ margin: 0, color: 'var(--text-primary)', fontSize: '1rem' }}>Time card records</h2>
                </div>
                <div style={{ fontSize: '0.78rem', color: 'var(--text-secondary)' }}>{cards.filter((card) => card.status === 'OPEN').length} open</div>
            </div>

            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: canCorrect ? 860 : 760 }}>
                <thead>
                    <tr style={{ borderBottom: '1px solid var(--border)' }}>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Employee</th>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Location</th>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Clock in</th>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Clock out</th>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Break</th>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Worked</th>
                        <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Status</th>
                        {canCorrect ? <th style={{ textAlign: 'left', padding: '0.55rem', fontSize: '0.72rem', color: 'var(--text-muted)' }}>Actions</th> : null}
                    </tr>
                </thead>
                <tbody>
                    {cards.length === 0 ? (
                        <tr>
                            <td colSpan={canCorrect ? 8 : 7} style={{ padding: '0.85rem 0.55rem', color: 'var(--text-secondary)', fontSize: '0.86rem' }}>
                                No time cards yet.
                            </td>
                        </tr>
                    ) : null}
                    {cards.map((card) => (
                        <tr key={card.id} style={{ borderBottom: '1px solid var(--border)' }}>
                            <td style={{ padding: '0.55rem', color: 'var(--text-primary)', fontWeight: 700 }}>{card.user?.name ?? selectedStaffName}</td>
                            <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{card.location?.name ?? 'No location'}</td>
                            <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{formatTimeCardTimestamp(card.clockInAt, card.displayTimeZone)}</td>
                            <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{formatTimeCardTimestamp(card.clockOutAt, card.displayTimeZone)}</td>
                            <td style={{ padding: '0.55rem', color: 'var(--text-secondary)' }}>{formatTimeCardDuration(card.breakMinutes)}</td>
                            <td style={{ padding: '0.55rem', color: 'var(--text-primary)', fontWeight: 800 }}>{formatTimeCardDuration(card.workedMinutes)}</td>
                            <td style={{ padding: '0.55rem', color: card.status === 'OPEN' ? '#166534' : 'var(--text-secondary)', fontWeight: 800 }}>{card.status}</td>
                            {canCorrect ? (
                                <td style={{ padding: '0.55rem' }}>
                                    <button
                                        type="button"
                                        className="btn btn-secondary"
                                        aria-label={'Correct time card for ' + (card.user?.name ?? selectedStaffName) + ' clocked in ' + formatTimeCardTimestamp(card.clockInAt, card.displayTimeZone)}
                                        onClick={() => onCorrect(card)}
                                    >
                                        Correct
                                    </button>
                                </td>
                            ) : null}
                        </tr>
                    ))}
                </tbody>
            </table>
            {nextCardsCursor ? (
                <div style={{ display: 'flex', justifyContent: 'center', marginTop: '0.85rem' }}>
                    <button type="button" className="btn btn-secondary" onClick={onLoadEarlier} disabled={isMoreCardsLoading}>
                        {isMoreCardsLoading ? 'Loading...' : 'Load earlier records'}
                    </button>
                </div>
            ) : null}
        </section>
    );
}