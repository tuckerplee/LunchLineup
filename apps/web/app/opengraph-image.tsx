import { ImageResponse } from 'next/og';

export const alt = 'LunchLineup workforce scheduling';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const shifts = [
    { time: '9:00', name: 'Opening shift', color: '#11875d' },
    { time: '11:30', name: 'Lunch coverage', color: '#2864dc' },
    { time: '2:00', name: 'Afternoon handoff', color: '#cc7f06' },
];

export default function OpenGraphImage() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    background: '#f7f9fb',
                    color: '#13221c',
                    padding: 64,
                    fontFamily: 'Arial, sans-serif',
                }}
            >
                <div style={{ width: '55%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 18 }}>
                        <div
                            style={{
                                width: 58,
                                height: 58,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 8,
                                background: '#11875d',
                                color: '#ffffff',
                                fontSize: 32,
                                fontWeight: 800,
                            }}
                        >
                            L
                        </div>
                        <div style={{ fontSize: 36, fontWeight: 800 }}>LunchLineup</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 22 }}>
                        <div style={{ fontSize: 62, lineHeight: 1.05, fontWeight: 800, maxWidth: 610 }}>
                            Scheduling that keeps the day moving.
                        </div>
                        <div style={{ fontSize: 25, lineHeight: 1.35, color: '#4b5f55', maxWidth: 560 }}>
                            Plan shifts, coverage, breaks, and time cards from one operational workspace.
                        </div>
                    </div>
                    <div style={{ fontSize: 20, color: '#4b5f55' }}>lunchlineup.com</div>
                </div>
                <div
                    style={{
                        width: '45%',
                        display: 'flex',
                        flexDirection: 'column',
                        alignSelf: 'center',
                        background: '#ffffff',
                        border: '2px solid #dbe3df',
                        borderRadius: 8,
                        padding: 30,
                        gap: 18,
                        boxShadow: '0 16px 44px rgba(19, 34, 28, 0.10)',
                    }}
                >
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <div style={{ fontSize: 23, fontWeight: 800 }}>Today</div>
                        <div style={{ fontSize: 17, color: '#4b5f55' }}>Coverage ready</div>
                    </div>
                    {shifts.map((shift) => (
                        <div
                            key={shift.time}
                            style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 16,
                                padding: '18px 0',
                                borderTop: '1px solid #e8eeeb',
                            }}
                        >
                            <div style={{ width: 64, fontSize: 18, fontWeight: 700 }}>{shift.time}</div>
                            <div style={{ width: 8, height: 44, borderRadius: 4, background: shift.color }} />
                            <div style={{ display: 'flex', flexDirection: 'column', gap: 5 }}>
                                <div style={{ fontSize: 20, fontWeight: 700 }}>{shift.name}</div>
                                <div style={{ fontSize: 16, color: '#607168' }}>Assigned and confirmed</div>
                            </div>
                        </div>
                    ))}
                </div>
            </div>
        ),
        size,
    );
}