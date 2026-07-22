import type { Metadata } from 'next';
import Link from 'next/link';
import {
  ArrowRight,
  BellRing,
  Check,
  CheckCircle2,
  Clock3,
  FileCheck2,
  KeyRound,
  LockKeyhole,
  MapPin,
  Menu,
  Users,
  Utensils,
} from 'lucide-react';
import { LunchLineupMark } from '@/components/branding/LunchLineupMark';
import { HomePerspectiveSwitcher } from '@/components/marketing/HomePerspectiveSwitcher';
import { HomeSchedulePreview } from '@/components/marketing/HomeSchedulePreview';
import styles from '@/components/marketing/homepage.module.css';
import { isSelfServiceSignupAvailable } from './onboarding/challenge';

export const metadata: Metadata = {
  title: 'The schedule, already thinking ahead',
  description: 'Build the week with availability, breaks, coverage, and time review in one clear flow.',
  openGraph: {
    title: 'The schedule, already thinking ahead | LunchLineup',
    description: 'Build the week with availability, breaks, coverage, and time review in one clear flow.',
    url: '/',
    images: [{ url: '/opengraph-image', width: 1200, height: 630, alt: 'LunchLineup weekly schedule preview' }],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'The schedule, already thinking ahead | LunchLineup',
    description: 'Build the week with availability, breaks, coverage, and time review in one clear flow.',
    images: ['/opengraph-image'],
  },
};

const WORKFLOW_STEPS = [
  { number: '01', title: 'Plan', copy: 'Bring availability and location context into the week.' },
  { number: '02', title: 'Build', copy: 'Shape shifts while coverage and breaks stay visible.' },
  { number: '03', title: 'Publish', copy: 'Move a reviewed schedule from draft to the team.' },
  { number: '04', title: 'Notify', copy: 'Make schedule updates easy for people to spot.' },
  { number: '05', title: 'Review', copy: 'Carry clock activity and corrections into review.' },
];

const FOOTER_LINKS = [
  { href: '/status', label: 'Status' },
  { href: '/privacy', label: 'Privacy' },
  { href: '/terms', label: 'Terms' },
  { href: '/security', label: 'Security' },
  { href: '/subprocessors', label: 'Subprocessors' },
];

type PrimaryAction = {
  href: '/onboarding' | '/auth/login';
  label: 'Create your workspace' | 'Open beta workspace';
};

function isSelfServeSignupOpen(): boolean {
  return isSelfServiceSignupAvailable(
    process.env.NEXT_PUBLIC_SIGNUP_MODE ?? process.env.PUBLIC_SIGNUP_MODE,
  );
}

function getPrimaryAction(selfServeSignupOpen: boolean): PrimaryAction {
  return selfServeSignupOpen
    ? { href: '/onboarding', label: 'Create your workspace' }
    : { href: '/auth/login', label: 'Open beta workspace' };
}

function Header({ primaryAction }: { primaryAction: PrimaryAction }) {
  return (
    <header className={styles.header}>
      <div className={styles.headerInner}>
        <Link href="/" className={styles.brand} aria-label="LunchLineup home">
          <LunchLineupMark size={36} />
          <span>LunchLineup</span>
        </Link>
        <nav className={styles.desktopNav} aria-label="Primary navigation">
          <a href="#product">Product</a>
          <a href="#workflow">How it works</a>
          <a href="#security">Security</a>
        </nav>
        <div className={styles.headerActions}>
          <Link href="/auth/login" className={styles.signIn}>Sign in</Link>
          <Link href={primaryAction.href} className={styles.primaryLink}>{primaryAction.label}<ArrowRight size={15} aria-hidden="true" /></Link>
        </div>
        <details className={styles.mobileMenu}>
          <summary aria-label="Open navigation"><Menu size={21} aria-hidden="true" /><span>Menu</span></summary>
          <nav aria-label="Mobile navigation">
            <a href="#product">Product</a>
            <a href="#workflow">How it works</a>
            <a href="#security">Security</a>
            <Link href="/auth/login">Sign in</Link>
            <Link href={primaryAction.href}>{primaryAction.label}</Link>
          </nav>
        </details>
      </div>
    </header>
  );
}

function StaffAvailabilityVisual() {
  return (
    <div className={styles.peopleVisual} role="group" aria-label="Staff, availability, and locations preview">
      <div className={styles.peopleTopline}><span>Team</span><span>Availability</span><span>Location</span></div>
      {[
        ['MC', 'Maya Chen', 'Available', 'Downtown'],
        ['JL', 'Jordan Lee', 'Until 6:00p', 'Downtown'],
        ['CP', 'Casey Park', 'After 10:00a', 'Riverside'],
      ].map(([initials, name, availability, location], index) => (
        <div className={styles.peopleRow} key={name}>
          <span className={styles.peopleAvatar} data-tone={index}>{initials}</span>
          <strong>{name}</strong>
          <span><Check size={13} aria-hidden="true" /> {availability}</span>
          <small><MapPin size={13} aria-hidden="true" /> {location}</small>
        </div>
      ))}
    </div>
  );
}

function TimeReviewVisual() {
  return (
    <div className={styles.timeVisual} role="group" aria-label="Time card review preview">
      <div className={styles.timeHeading}><span>Time review</span><strong>Week of Jul 20</strong></div>
      {[
        ['Maya Chen', '32h 00m', 'Ready'],
        ['Jordan Lee', '29h 42m', 'Review'],
        ['Casey Park', '24h 00m', 'Ready'],
      ].map(([name, hours, state]) => (
        <div className={styles.timeRow} key={name}>
          <span><i aria-hidden="true" />{name}</span>
          <strong>{hours}</strong>
          <small data-review={state === 'Review'}>{state}</small>
        </div>
      ))}
      <div className={styles.timeTotal}><span>Reviewed hours</span><strong>85h 42m</strong></div>
    </div>
  );
}

export default function HomePage() {
  const primaryAction = getPrimaryAction(isSelfServeSignupOpen());

  return (
    <div className={styles.home}>
      <Header primaryAction={primaryAction} />
      <main>

      <section className={styles.hero} id="product">
        <div className={styles.heroInner}>
          <div className={styles.heroCopy}>
            <h1>The schedule,<br />already thinking ahead.</h1>
            <p>Build the week with availability, breaks, coverage, and time review in one clear flow.</p>
            <div className={styles.heroActions}>
              <Link href={primaryAction.href} className={styles.heroPrimary}>{primaryAction.label}<ArrowRight size={17} aria-hidden="true" /></Link>
              <a href="#workflow" className={styles.heroSecondary}>See how it works</a>
            </div>
            <ul className={styles.proofList} aria-label="Schedule planning highlights">
              <li><CheckCircle2 size={16} aria-hidden="true" />Availability in view</li>
              <li><Utensils size={16} aria-hidden="true" />Breaks planned</li>
              <li><Users size={16} aria-hidden="true" />Coverage visible</li>
            </ul>
          </div>
          <div className={styles.heroVisual}><HomeSchedulePreview /></div>
        </div>
      </section>

      <section className={styles.perspectiveSection} id="perspectives">
        <div className={styles.sectionInner}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionKicker}>A shared operating picture</span>
            <h2>One schedule. Three perspectives.</h2>
            <p>Move through the same week from the view that matters now, without rebuilding the story each time.</p>
          </div>
          <HomePerspectiveSwitcher />
        </div>
      </section>

      <section className={styles.workflowSection} id="workflow">
        <div className={styles.sectionInner}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionKicker}>The weekly rhythm</span>
            <h2>A clear flow from plan to review.</h2>
            <p>Each step keeps the next one close, so the work reads as a sequence instead of a stack of disconnected tools.</p>
          </div>
          <div className={styles.workflowLine}>
            {WORKFLOW_STEPS.map((step, index) => (
              <article className={styles.workflowStep} key={step.number}>
                <span className={styles.stepNumber}>{step.number}</span>
                <div className={styles.stepVisual} data-step={index + 1}>
                  <i /><i /><i />
                </div>
                <h3>{step.title}</h3>
                <p>{step.copy}</p>
              </article>
            ))}
          </div>
        </div>
      </section>

      <section className={styles.depthSection}>
        <div className={styles.sectionInner}>
          <div className={styles.sectionHeader}>
            <span className={styles.sectionKicker}>Operational depth</span>
            <h2>More than a calendar. Still centered on the schedule.</h2>
          </div>
          <div className={styles.depthRows}>
            <article className={styles.depthRow}>
              <div className={styles.depthCopy}>
                <span className={styles.depthIcon}><Users size={18} aria-hidden="true" /></span>
                <h3>People and places belong in the same planning picture.</h3>
                <p>Keep roles, availability, invitations, and location scope close to the schedule managers are building.</p>
                <ul><li>Profiles and roles</li><li>Availability context</li><li>Location-aware planning</li></ul>
              </div>
              <StaffAvailabilityVisual />
            </article>
            <article className={styles.depthRowReverse}>
              <div className={styles.depthCopy}>
                <span className={styles.depthIcon}><Clock3 size={18} aria-hidden="true" /></span>
                <h3>Carry the week into time review.</h3>
                <p>Review clock activity and corrections with the schedule close enough to provide useful context.</p>
                <ul><li>Time card review</li><li>Correction workflow</li><li>Controlled payroll export</li></ul>
              </div>
              <TimeReviewVisual />
            </article>
          </div>
        </div>
      </section>

      <section className={styles.trustSection} id="security">
        <div className={styles.trustInner}>
          <div className={styles.trustCopy}>
            <span className={styles.sectionKickerDark}>Trust is part of the workflow</span>
            <h2>Built for the responsibility behind every shift.</h2>
            <p>Access, tenant boundaries, and review controls are treated as product behavior, not footer language.</p>
          </div>
          <div className={styles.trustPoints}>
            <div><LockKeyhole size={20} aria-hidden="true" /><strong>Tenant boundaries</strong><span>Workspace data stays scoped to the people who belong there.</span></div>
            <div><KeyRound size={20} aria-hidden="true" /><strong>Role-aware access</strong><span>MFA and permissions support accountable day-to-day work.</span></div>
            <div><FileCheck2 size={20} aria-hidden="true" /><strong>Review controls</strong><span>Draft, publish, correction, and lock states keep decisions visible.</span></div>
          </div>
          <Link href="/security" className={styles.trustLink}>Explore security practices <ArrowRight size={15} aria-hidden="true" /></Link>
        </div>
      </section>

      <section className={styles.finalCta}>
        <div>
          <span><BellRing size={17} aria-hidden="true" /> A calmer weekly rhythm</span>
          <h2>A clearer week starts with the schedule.</h2>
          <p>Bring planning, people, and review into one composed operating flow.</p>
          <Link href={primaryAction.href} className={styles.heroPrimary}>{primaryAction.label}<ArrowRight size={17} aria-hidden="true" /></Link>
        </div>
      </section>
      </main>

      <footer className={styles.footer}>
        <div className={styles.footerBrand}><LunchLineupMark size={34} /><span><strong>LunchLineup</strong><small>The schedule, already thinking ahead.</small></span></div>
        <nav aria-label="Legal and service links">{FOOTER_LINKS.map((link) => <Link key={link.href} href={link.href}>{link.label}</Link>)}</nav>
        <small>LunchLineup workforce scheduling</small>
      </footer>
    </div>
  );
}
