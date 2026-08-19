import Link from 'next/link';
import { CalendarDays, ChevronDown, Filter, MapPin, Utensils } from 'lucide-react';
import styles from './homepage.module.css';

type ShiftTone = 'cyan' | 'blue' | 'violet' | 'amber';

type Shift = {
  time: string;
  breakTime: string;
  status: 'Covered' | 'Needs coverage';
};

type TeamSchedule = {
  name: string;
  role: string;
  hours: string;
  initials: string;
  tone: ShiftTone;
  shifts: Array<Shift | null>;
};

const DAYS = ['Sun 20', 'Mon 21', 'Tue 22', 'Wed 23', 'Thu 24', 'Fri 25', 'Sat 26'];

const TEAM_SCHEDULES: TeamSchedule[] = [
  {
    name: 'Maya Chen',
    role: 'Manager',
    hours: '32h',
    initials: 'MC',
    tone: 'cyan',
    shifts: [
      null,
      { time: '8:00a - 4:00p', breakTime: '12:00p - 12:30p', status: 'Covered' },
      { time: '9:00a - 5:00p', breakTime: '1:00p - 1:30p', status: 'Covered' },
      { time: '10:00a - 6:00p', breakTime: '1:30p - 2:00p', status: 'Covered' },
      { time: '8:00a - 4:00p', breakTime: '12:00p - 12:30p', status: 'Covered' },
      { time: '9:00a - 5:00p', breakTime: '1:00p - 1:30p', status: 'Covered' },
      null,
    ],
  },
  {
    name: 'Jordan Lee',
    role: 'Shift lead',
    hours: '30h',
    initials: 'JL',
    tone: 'blue',
    shifts: [
      null,
      { time: '10:00a - 6:00p', breakTime: '1:30p - 2:00p', status: 'Covered' },
      { time: '8:00a - 4:00p', breakTime: '12:00p - 12:30p', status: 'Covered' },
      { time: '9:00a - 5:00p', breakTime: '1:00p - 1:30p', status: 'Covered' },
      null,
      { time: '10:00a - 6:00p', breakTime: '1:30p - 2:00p', status: 'Needs coverage' },
      { time: '11:00a - 7:00p', breakTime: '2:30p - 3:00p', status: 'Covered' },
    ],
  },
  {
    name: 'Casey Park',
    role: 'Team member',
    hours: '24h',
    initials: 'CP',
    tone: 'violet',
    shifts: [
      null,
      { time: '11:00a - 7:00p', breakTime: '2:30p - 3:00p', status: 'Covered' },
      null,
      { time: '10:00a - 6:00p', breakTime: '1:30p - 2:00p', status: 'Covered' },
      { time: '9:00a - 5:00p', breakTime: '1:00p - 1:30p', status: 'Covered' },
      null,
      { time: '8:00a - 4:00p', breakTime: '12:00p - 12:30p', status: 'Covered' },
    ],
  },
  {
    name: 'Alex Rivera',
    role: 'Team member',
    hours: '28h',
    initials: 'AR',
    tone: 'amber',
    shifts: [
      { time: '9:00a - 5:00p', breakTime: '1:00p - 1:30p', status: 'Covered' },
      null,
      { time: '11:00a - 7:00p', breakTime: '2:30p - 3:00p', status: 'Covered' },
      { time: '8:00a - 4:00p', breakTime: '12:00p - 12:30p', status: 'Needs coverage' },
      null,
      { time: '11:00a - 7:00p', breakTime: '2:30p - 3:00p', status: 'Covered' },
      null,
    ],
  },
];

function ShiftCell({ shift, tone }: { shift: Shift | null; tone: ShiftTone }) {
  if (!shift) {
    return <span className={styles.noShift}>No shift</span>;
  }

  return (
    <div className={`${styles.shiftCard} ${styles[`shiftCard_${tone}`]}`}>
      <strong>{shift.time}</strong>
      <span><Utensils size={12} aria-hidden="true" />{shift.breakTime}</span>
      <small className={shift.status === 'Covered' ? styles.covered : styles.needsCoverage}>
        {shift.status}
      </small>
    </div>
  );
}

export function HomeSchedulePreview() {
  return (
    <div className={styles.scheduleWindow} role="group" aria-label="LunchLineup weekly schedule preview">
      <div className={styles.scheduleToolbar}>
        <span className={styles.toolbarButton}>
          <MapPin size={16} aria-hidden="true" /> Downtown <ChevronDown size={14} aria-hidden="true" />
        </span>
        <span className={styles.toolbarButton}>
          <CalendarDays size={16} aria-hidden="true" /> Week of July 20 <ChevronDown size={14} aria-hidden="true" />
        </span>
        <div className={styles.toolbarSpacer} />
        <span className={styles.iconButton} aria-hidden="true">
          <Filter size={16} aria-hidden="true" />
        </span>
        <span className={styles.draftState}><i aria-hidden="true" /> Draft</span>
        <Link href="/auth/login" className={styles.reviewButton}>Review schedule <span aria-hidden="true">-&gt;</span></Link>
      </div>

      <div className={styles.scheduleScroller} role="region" aria-label="Weekly schedule, scroll horizontally for more days" tabIndex={0}>
        <table className={styles.scheduleTable}>
          <thead>
            <tr>
              <th scope="col">Team member</th>
              {DAYS.map((day) => <th key={day} scope="col">{day}<span>8a&nbsp;&nbsp;12p&nbsp;&nbsp;4p</span></th>)}
            </tr>
          </thead>
          <tbody>
            {TEAM_SCHEDULES.map((member) => (
              <tr key={member.name}>
                <th scope="row">
                  <span className={`${styles.avatar} ${styles[`avatar_${member.tone}`]}`} aria-hidden="true">{member.initials}</span>
                  <span className={styles.memberMeta}><strong>{member.name}</strong><span>{member.role}</span><small>{member.hours}</small></span>
                </th>
                {member.shifts.map((shift, index) => <td key={`${member.name}-${DAYS[index]}`}><ShiftCell shift={shift} tone={member.tone} /></td>)}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className={styles.scheduleLegend} role="group" aria-label="Schedule legend">
        <span><i className={styles.legendCovered} aria-hidden="true" />Covered</span>
        <span><i className={styles.legendAttention} aria-hidden="true" />Needs coverage</span>
        <span><i className={styles.legendEmpty} aria-hidden="true" />No shift</span>
        <span><Utensils size={14} aria-hidden="true" />Break</span>
        <small>All times shown in local time</small>
      </div>
    </div>
  );
}
