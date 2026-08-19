import { ImageResponse } from 'next/og';

export const alt = 'LunchLineup weekly schedule preview';
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

const days = ['Mon 21', 'Tue 22', 'Wed 23', 'Thu 24', 'Fri 25'];
const team = [
    { initials: 'MC', name: 'Maya', color: '#22B8CF', background: '#EDFBFC', border: '#9DDFE7', shifts: [true, true, true, true, true] },
    { initials: 'JL', name: 'Jordan', color: '#2F63FF', background: '#F0F4FF', border: '#B7CAFF', shifts: [true, true, true, false, true] },
    { initials: 'CP', name: 'Casey', color: '#7557B7', background: '#F7F3FE', border: '#D5C4F4', shifts: [false, true, true, true, false] },
];

export default function OpenGraphImage() {
    return new ImageResponse(
        (
            <div
                style={{
                    width: '100%',
                    height: '100%',
                    display: 'flex',
                    background: 'linear-gradient(135deg, #FFFFFF 0%, #F7F9FD 58%, #EEF3FF 100%)',
                    color: '#07111F',
                    padding: '54px 58px',
                    fontFamily: 'Arial, sans-serif',
                }}
            >
                <div style={{ width: '43%', display: 'flex', flexDirection: 'column', justifyContent: 'space-between' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
                        <div
                            style={{
                                width: 54,
                                height: 54,
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'center',
                                borderRadius: 13,
                                background: 'linear-gradient(135deg, #2F63FF, #22B8CF)',
                            }}
                        >
                            <div
                                style={{
                                    width: 29,
                                    height: 23,
                                    display: 'flex',
                                    border: '3px solid #FFFFFF',
                                    borderRadius: 5,
                                    position: 'relative',
                                }}
                            >
                                <div style={{ width: 17, height: 3, position: 'absolute', top: 7, left: 3, borderRadius: 2, background: '#FFFFFF' }} />
                            </div>
                        </div>
                        <div style={{ fontSize: 27, fontWeight: 800, letterSpacing: '-0.8px' }}>LunchLineup</div>
                    </div>
                    <div style={{ display: 'flex', flexDirection: 'column' }}>
                        <div style={{ fontSize: 59, lineHeight: 0.98, fontWeight: 800, letterSpacing: '-3px', maxWidth: 470 }}>
                            The schedule, already thinking ahead.
                        </div>
                        <div style={{ marginTop: 24, fontSize: 20, lineHeight: 1.45, color: '#526078', maxWidth: 430 }}>
                            Availability, breaks, coverage, and time review in one clear flow.
                        </div>
                    </div>
                    <div style={{ display: 'flex', gap: 22, color: '#526078', fontSize: 14, fontWeight: 700 }}>
                        <span style={{ display: 'flex' }}>Availability in view</span>
                        <span style={{ display: 'flex' }}>Coverage visible</span>
                    </div>
                </div>

                <div style={{ width: '57%', paddingLeft: 38, display: 'flex', alignItems: 'center' }}>
                    <div
                        style={{
                            width: '100%',
                            height: 440,
                            display: 'flex',
                            flexDirection: 'column',
                            overflow: 'hidden',
                            border: '1px solid #CBD5E1',
                            borderRadius: 18,
                            background: '#FFFFFF',
                            boxShadow: '0 24px 60px rgba(37, 57, 88, 0.14)',
                        }}
                    >
                        <div
                            style={{
                                height: 58,
                                padding: '0 16px',
                                display: 'flex',
                                alignItems: 'center',
                                justifyContent: 'space-between',
                                borderBottom: '1px solid #E7ECF3',
                            }}
                        >
                            <div style={{ display: 'flex', gap: 8 }}>
                                <span style={{ padding: '8px 11px', display: 'flex', border: '1px solid #D7DFE9', borderRadius: 7, color: '#344158', fontSize: 11, fontWeight: 700 }}>Downtown</span>
                                <span style={{ padding: '8px 11px', display: 'flex', border: '1px solid #D7DFE9', borderRadius: 7, color: '#344158', fontSize: 11, fontWeight: 700 }}>Week of Jul 20</span>
                            </div>
                            <span style={{ padding: '8px 12px', display: 'flex', borderRadius: 7, background: '#07111F', color: '#FFFFFF', fontSize: 10, fontWeight: 800 }}>Review schedule</span>
                        </div>
                        <div style={{ height: 49, paddingLeft: 100, display: 'flex', borderBottom: '1px solid #E7ECF3', background: '#F7F9FC' }}>
                            {days.map((day) => (
                                <div key={day} style={{ width: 90, padding: '13px 7px', display: 'flex', borderLeft: '1px solid #E7ECF3', color: '#526078', fontSize: 9, fontWeight: 800 }}>{day}</div>
                            ))}
                        </div>
                        {team.map((member, rowIndex) => (
                            <div key={member.name} style={{ height: 91, display: 'flex', borderBottom: '1px solid #E7ECF3' }}>
                                <div style={{ width: 100, padding: '17px 10px', display: 'flex', alignItems: 'center', gap: 7 }}>
                                    <span style={{ width: 27, height: 27, display: 'flex', alignItems: 'center', justifyContent: 'center', borderRadius: 99, background: member.background, color: '#17324E', fontSize: 8, fontWeight: 800 }}>{member.initials}</span>
                                    <span style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                        <strong style={{ fontSize: 9 }}>{member.name}</strong>
                                        <small style={{ color: '#7A8799', fontSize: 7 }}>Team</small>
                                    </span>
                                </div>
                                {member.shifts.map((hasShift, index) => (
                                    <div key={days[index]} style={{ width: 90, padding: '13px 5px', display: 'flex', borderLeft: '1px solid #E7ECF3' }}>
                                        {hasShift ? (
                                            <div style={{ width: '100%', padding: '8px 7px', display: 'flex', flexDirection: 'column', gap: 5, border: '1px solid ' + member.border, borderRadius: 6, background: member.background }}>
                                                <strong style={{ color: '#17324E', fontSize: 8 }}>{8 + rowIndex}:00 - {4 + rowIndex}:00</strong>
                                                <span style={{ color: member.color, fontSize: 7, fontWeight: 800 }}>Covered</span>
                                            </div>
                                        ) : (
                                            <span style={{ margin: 'auto', display: 'flex', color: '#C1CAD6', fontSize: 10 }}>-</span>
                                        )}
                                    </div>
                                ))}
                            </div>
                        ))}
                        <div style={{ flex: 1, padding: '0 16px', display: 'flex', alignItems: 'center', gap: 16, color: '#68758A', fontSize: 8 }}>
                            <span style={{ display: 'flex', color: '#17A765' }}>Covered</span>
                            <span style={{ display: 'flex', color: '#D94A64' }}>Needs coverage</span>
                            <span style={{ marginLeft: 'auto', display: 'flex' }}>All times in local time</span>
                        </div>
                    </div>
                </div>
            </div>
        ),
        size,
    );
}
