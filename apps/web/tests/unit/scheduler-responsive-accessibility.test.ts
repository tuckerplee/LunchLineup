import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  SCHEDULER_DESKTOP_FIT_MIN_WIDTH,
  resolveSchedulerTimelineLayout,
} from '../../components/scheduling/scheduler-projection';

const webRoot = resolve(import.meta.dirname, '../..');
const schedulerSource = readFileSync(
  resolve(webRoot, 'components/scheduling/StaffScheduler.tsx'),
  'utf8',
);
const schedulingPageSource = readFileSync(
  resolve(webRoot, 'app/dashboard/scheduling/page.tsx'),
  'utf8',
);

function contrastRatio(foreground: string, background: string): number {
  const luminance = (hex: string) => {
    const channels = hex.match(/[0-9a-f]{2}/gi)?.map((value) => Number.parseInt(value, 16) / 255) ?? [];
    const [red, green, blue] = channels.map((value) => (
      value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
    ));
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const lighter = Math.max(luminance(foreground), luminance(background));
  const darker = Math.min(luminance(foreground), luminance(background));
  return (lighter + 0.05) / (darker + 0.05);
}

describe('scheduler responsive timeline contract', () => {
  it('keeps the mobile three-day board at an editable fixed scale with horizontal inspection', () => {
    const layout = resolveSchedulerTimelineLayout('threeDay', 195, 39);

    expect(layout).toEqual({
      hourWidth: 48,
      timelineWidth: 1_872,
      allowsHorizontalScroll: true,
    });
    expect(layout.hourWidth).toBeGreaterThanOrEqual(40);
  });

  it('preserves fit-to-width behavior for desktop day and three-day boards', () => {
    const layout = resolveSchedulerTimelineLayout(
      'threeDay',
      SCHEDULER_DESKTOP_FIT_MIN_WIDTH,
      39,
    );

    expect(layout.timelineWidth).toBe(SCHEDULER_DESKTOP_FIT_MIN_WIDTH);
    expect(layout.hourWidth).toBeCloseTo(SCHEDULER_DESKTOP_FIT_MIN_WIDTH / 39);
    expect(layout.allowsHorizontalScroll).toBe(false);
  });

  it('uses the shared layout scale for a focusable horizontally scrollable timeline', () => {
    expect(schedulerSource).toContain(
      'resolveSchedulerTimelineLayout(viewMode, viewportWidth, totalHours)',
    );
    expect(schedulerSource).toContain(
      "style={{ overflowX: allowsHorizontalScroll ? 'auto' : 'hidden' }}",
    );
    expect(schedulerSource).toContain('aria-describedby="scheduler-timeline-instructions"');
    expect(schedulerSource).toContain('tabIndex={0}');
    expect(schedulerSource).not.toContain(
      "style={{ overflowX: viewMode === 'week' ? 'auto' : 'hidden' }}",
    );
  });

  it('fails closed before graphical DST ambiguity can trigger a shift mutation', () => {
    expect(schedulerSource).toContain('onTimeSelectionError?: (message: string) => void');
    expect(schedulerSource).toContain('const startIso = wallClockDateToIso(newStart, timeZone)');
    expect(schedulerSource).toContain('const endIso = wallClockDateToIso(newEnd, timeZone)');
    expect(schedulerSource).toMatch(/catch \(error\) \{\s+onTimeSelectionError\?\.\(\(error as Error\)\.message\);/);
    expect(schedulingPageSource).toContain('onTimeSelectionError={(message) => {');
  });

  it('keeps copy and move gestures separate while exposing a touch-friendly duplicate action', () => {
    expect(schedulerSource).toContain("mode: 'move' | 'copy'");
    expect(schedulerSource).toContain('(e.shiftKey || e.altKey) && onEventCopy');
    expect(schedulerSource).toContain("drag.mode === 'copy' ? onEventCopy : onEventChange");
    expect(schedulerSource).toContain('hold Shift or Alt while dragging to copy');
    expect(schedulingPageSource).toContain('onEventCopy={capabilities.canWriteShifts && locationDataCurrent');
    expect(schedulingPageSource).toContain('<Copy size={14} /> Duplicate shift');
    expect(schedulingPageSource).toContain('clientId: attempt.key');
    expect(schedulingPageSource).toContain("'Shift copy failed. The source shift was not changed.'");
  });
});

describe('scheduler accessibility semantics', () => {
  it('bootstraps the browser-local calendar date without server/client clock drift', () => {
    expect(schedulingPageSource).not.toContain('const TODAY = new Date()');
    expect(schedulingPageSource).toContain(
      "const DATE_BOOTSTRAP_PLACEHOLDER = '2000-01-01';",
    );
    expect(schedulingPageSource).toContain(
      'const [isHydrated, setIsHydrated] = useState(Boolean(requestedDate));',
    );
    expect(schedulingPageSource).toMatch(
      /if \(!isHydrated\) return;\s+void loadSchedule/,
    );
    expect(schedulingPageSource).toContain(
      "value={isHydrated ? selectedDate : ''}",
    );
  });

  it('names the schedule date input', () => {
    expect(schedulingPageSource).toMatch(
      /<input\s+aria-label="Schedule date"\s+type="date"/,
    );
  });

  it('exposes named team and timeline rows through valid list semantics', () => {
    expect(schedulerSource).toContain(
      'className="resource-list" ref={resourceListRef} role="list" aria-label="Scheduled team members"',
    );
    expect(schedulerSource).toContain(
      'className="resource-row-name" role="listitem" aria-label={r.title',
    );
    expect(schedulerSource).toContain(
      'className="timeline-body" role="list" aria-label="Staff schedule rows"',
    );
    expect(schedulerSource).toContain('role="listitem"');
    expect(schedulerSource).toContain(
      "aria-label={resource.title + ', ' + resource.role + ', schedule timeline'}",
    );
  });

  it('keeps compact scheduler labels above the WCAG AA contrast threshold', () => {
    expect(schedulerSource.match(/color: #526381;/g)).toHaveLength(4);
    expect(schedulerSource).toContain("color: '#1f2d49'");
    expect(contrastRatio('#526381', '#f9fbff')).toBeGreaterThanOrEqual(4.5);
    expect(contrastRatio('#1f2d49', '#ffffff')).toBeGreaterThanOrEqual(4.5);
  });
});
