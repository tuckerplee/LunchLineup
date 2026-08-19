'use client';

import { useId, useRef, useState, type KeyboardEvent } from 'react';
import { Building2, CheckCircle2, Clock3, MapPin, Users } from 'lucide-react';
import { LazyMotion, MotionConfig, domAnimation, m } from 'framer-motion';
import styles from './homepage.module.css';

type PerspectiveKey = 'manager' | 'operator' | 'team';

type Perspective = {
  key: PerspectiveKey;
  label: string;
  title: string;
  summary: string;
  note: string;
  checks: Array<{ label: string; value: string; tone: 'ready' | 'review' | 'draft' }>;
};

const PERSPECTIVES: Perspective[] = [
  {
    key: 'manager',
    label: 'Manager',
    title: 'Build with the whole shift in view.',
    summary: 'Availability, breaks, and open coverage stay visible while the week takes shape.',
    note: '2 shifts need a final look',
    checks: [
      { label: 'Availability', value: 'Ready', tone: 'ready' },
      { label: 'Coverage', value: '2 to review', tone: 'review' },
      { label: 'Schedule', value: 'Draft', tone: 'draft' },
    ],
  },
  {
    key: 'operator',
    label: 'Operator',
    title: 'See how locations fit together.',
    summary: 'Move from the big picture into location-level coverage without losing the weekly rhythm.',
    note: '2 locations in this view',
    checks: [
      { label: 'Locations', value: '2 in scope', tone: 'ready' },
      { label: 'Coverage', value: 'By location', tone: 'review' },
      { label: 'Time review', value: 'In progress', tone: 'draft' },
    ],
  },
  {
    key: 'team',
    label: 'Team',
    title: 'Give every shift a clear next step.',
    summary: 'Published hours, meal timing, and schedule details arrive in one straightforward view.',
    note: 'Local time shown throughout',
    checks: [
      { label: 'Schedule', value: 'Published', tone: 'ready' },
      { label: 'Lunch and break', value: 'Planned', tone: 'ready' },
      { label: 'Updates', value: 'Easy to spot', tone: 'draft' },
    ],
  },
];

const ROWS = [
  { name: 'Maya', initials: 'MC', start: '8:00', width: '58%', tone: 'cyan' },
  { name: 'Jordan', initials: 'JL', start: '10:00', width: '66%', tone: 'blue' },
  { name: 'Casey', initials: 'CP', start: '11:00', width: '51%', tone: 'violet' },
];

export function HomePerspectiveSwitcher() {
  const [activeKey, setActiveKey] = useState<PerspectiveKey>('manager');
  const id = useId();
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const active = PERSPECTIVES.find((view) => view.key === activeKey) ?? PERSPECTIVES[0];

  function selectTab(index: number) {
    const view = PERSPECTIVES[index];
    if (!view) return;
    setActiveKey(view.key);
    tabRefs.current[index]?.focus();
  }

  function handleTabKeyDown(event: KeyboardEvent<HTMLButtonElement>, index: number) {
    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown') {
      nextIndex = (index + 1) % PERSPECTIVES.length;
    } else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') {
      nextIndex = (index - 1 + PERSPECTIVES.length) % PERSPECTIVES.length;
    } else if (event.key === 'Home') {
      nextIndex = 0;
    } else if (event.key === 'End') {
      nextIndex = PERSPECTIVES.length - 1;
    }
    if (nextIndex === null) return;
    event.preventDefault();
    selectTab(nextIndex);
  }

  return (
    <div className={styles.perspectiveShell}>
      <div className={styles.perspectiveTabs} role="tablist" aria-label="Product perspectives">
        {PERSPECTIVES.map((view, index) => (
          <button
            key={view.key}
            ref={(node) => { tabRefs.current[index] = node; }}
            type="button"
            id={id + '-' + view.key + '-tab'}
            role="tab"
            aria-selected={view.key === activeKey}
            aria-controls={id + '-panel'}
            tabIndex={view.key === activeKey ? 0 : -1}
            className={view.key === activeKey ? styles.perspectiveTabActive : styles.perspectiveTab}
            onClick={() => setActiveKey(view.key)}
            onKeyDown={(event) => handleTabKeyDown(event, index)}
          >
            <span>{view.label}</span>
            <small>{view.title}</small>
          </button>
        ))}
      </div>

      <LazyMotion features={domAnimation}>
        <MotionConfig reducedMotion="user">
          <m.div
            key={active.key}
            id={id + '-panel'}
            role="tabpanel"
            aria-labelledby={id + '-' + active.key + '-tab'}
            className={styles.perspectivePanel}
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.24, ease: [0.2, 0.8, 0.2, 1] }}
          >
            <aside className={styles.locationRail}>
              <span className={styles.miniLabel}>Workspace</span>
              <strong>LunchLineup</strong>
              <div className={styles.locationItemActive}><Building2 size={15} aria-hidden="true" /> All locations</div>
              <div className={styles.locationItem}><MapPin size={15} aria-hidden="true" /> Downtown</div>
              <div className={styles.locationItem}><MapPin size={15} aria-hidden="true" /> Riverside</div>
              <div className={styles.locationPeople}><Users size={15} aria-hidden="true" /> 18 team members</div>
            </aside>

            <div className={styles.perspectiveBoard}>
              <div className={styles.boardHeading}>
                <div><span className={styles.miniLabel}>{active.label} view</span><h3>{active.title}</h3></div>
                <span className={styles.boardWeek}><Clock3 size={14} aria-hidden="true" /> Jul 20 - 26</span>
              </div>
              <p>{active.summary}</p>
              <div className={styles.boardGrid} role="group" aria-label={active.label + ' schedule projection'}>
                <div className={styles.boardAxis}><span>8a</span><span>12p</span><span>4p</span><span>8p</span></div>
                {ROWS.map((row, index) => (
                  <div className={styles.boardRow} key={row.name}>
                    <span className={styles.boardAvatar + ' ' + styles['boardAvatar_' + row.tone]}>{row.initials}</span>
                    <strong>{row.name}</strong>
                    <div className={styles.boardTrack}>
                      <span
                        className={styles.boardShift + ' ' + styles['boardShift_' + row.tone]}
                        style={{ marginLeft: String(index * 7) + '%', width: row.width }}
                      >
                        {row.start} <i aria-hidden="true" />
                      </span>
                    </div>
                  </div>
                ))}
              </div>
              <small className={styles.boardNote}><CheckCircle2 size={14} aria-hidden="true" /> {active.note}</small>
            </div>

            <aside className={styles.reviewRail}>
              <span className={styles.miniLabel}>Review</span>
              {active.checks.map((check) => (
                <div className={styles.reviewItem} key={check.label}>
                  <span>{check.label}</span>
                  <strong className={styles['review_' + check.tone]}>{check.value}</strong>
                </div>
              ))}
              <a href="#workflow" className={styles.reviewLink}>Follow the workflow <span aria-hidden="true">-&gt;</span></a>
            </aside>
          </m.div>
        </MotionConfig>
      </LazyMotion>
    </div>
  );
}
