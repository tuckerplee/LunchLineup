'use client';

import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { ArrowLeft, Printer, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { fetchJsonWithSession } from '@/lib/client-api';
import { createLatestRequestGate } from '@/lib/latest-request';
import { formatTimeInTimeZone, localDateRange, safeTimeZone } from '@/lib/location-timezone';
import {
  createPrintScheduleScope,
  isPrintScheduleScopeCurrent,
  type PrintScheduleScope,
} from './print-schedule-scope';

type StaffRole = 'SUPER_ADMIN' | 'ADMIN' | 'MANAGER' | 'STAFF';
type BreakItem = { startTime: string; endTime: string; paid: boolean };
type LocationItem = { id: string; name: string; timezone: string };
type ShiftRecord = {
  id: string;
  userId: string | null;
  startTime: string;
  endTime: string;
  role: string | null;
  user?: { id: string; name: string; role: StaffRole } | null;
  breaks?: BreakItem[];
};

type PrintRow = {
  id: string;
  employee: string;
  shift: string;
  pos: string;
  break1: string;
  lunch: string;
  break2: string;
};

const MIN_SCHEDULE_ROWS = 13;
const TIP_ROWS = 10;
const TRAINING_ROWS = 5;

function toDateInputValue(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function formatDateLabel(dateValue: string): string {
  const parsed = new Date(`${dateValue}T12:00:00.000Z`);
  if (!Number.isFinite(parsed.getTime())) return dateValue;
  return parsed.toLocaleDateString('en-US', { timeZone: 'UTC', month: 'long', day: 'numeric', year: 'numeric' });
}

function formatTime(dateIso: string, timeZone: string): string {
  try {
    return formatTimeInTimeZone(dateIso, timeZone).toLowerCase();
  } catch {
    return '';
  }
}

function formatRange(startIso: string, endIso: string, timeZone: string): string {
  const start = formatTime(startIso, timeZone);
  const end = formatTime(endIso, timeZone);
  return start && end ? `${start}-${end}` : '';
}

function roleToPos(role: string | null | undefined): string {
  const normalized = (role ?? '').trim();
  return /^\d+$/.test(normalized) ? normalized : '';
}

function shiftToPrintRow(shift: ShiftRecord, timeZone: string): PrintRow {
  const paid = [...(shift.breaks ?? [])].filter((item) => item.paid).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  const unpaid = [...(shift.breaks ?? [])].filter((item) => !item.paid).sort((a, b) => new Date(a.startTime).getTime() - new Date(b.startTime).getTime());
  return {
    id: shift.id,
    employee: shift.user?.name ?? 'Open shift',
    shift: formatRange(shift.startTime, shift.endTime, timeZone),
    pos: roleToPos(shift.role),
    break1: paid[0] ? formatTime(paid[0].startTime, timeZone) : '',
    lunch: unpaid[0] ? formatTime(unpaid[0].startTime, timeZone) : '',
    break2: paid[1] ? formatTime(paid[1].startTime, timeZone) : '',
  };
}

function PrintScheduleView() {
  const searchParams = useSearchParams();
  const [selectedDate, setSelectedDate] = useState(searchParams.get('date') || toDateInputValue(new Date()));
  const [shifts, setShifts] = useState<ShiftRecord[]>([]);
  const [timeZone, setTimeZone] = useState('UTC');
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [autoPrintDone, setAutoPrintDone] = useState(false);
  const [loadedScope, setLoadedScope] = useState<PrintScheduleScope | null>(null);
  const scheduleRequestGate = useRef(createLatestRequestGate<PrintScheduleScope>());
  const requestedLocationId = searchParams.get('locationId') ?? '';
  const selectedScope = useMemo(
    () => createPrintScheduleScope(selectedDate, requestedLocationId),
    [requestedLocationId, selectedDate],
  );

  const loadSchedule = useCallback(async (dateValue: string) => {
    const requestScope = createPrintScheduleScope(dateValue, requestedLocationId);
    const ticket = scheduleRequestGate.current.begin(requestScope);
    setIsLoading(true);
    setError(null);
    setLoadedScope(null);
    setShifts([]);
    try {
      const locationsPayload = await fetchJsonWithSession<{ data: LocationItem[] }>('/locations');
      const location = locationsPayload.data?.find((item) => item.id === requestedLocationId) ?? locationsPayload.data?.[0];
      const nextTimeZone = safeTimeZone(location?.timezone);
      const range = localDateRange(dateValue, 1, nextTimeZone);
      const locationQuery = location?.id ? `&locationId=${encodeURIComponent(location.id)}` : '';
      if (!scheduleRequestGate.current.isLatest(ticket)) return;
      const payload = await fetchJsonWithSession<{ data: ShiftRecord[] }>(
        `/shifts?startDate=${encodeURIComponent(range.start)}&endDate=${encodeURIComponent(range.end)}${locationQuery}`,
      );
      if (!scheduleRequestGate.current.isLatest(ticket)) return;
      setTimeZone(nextTimeZone);
      setShifts(payload.data ?? []);
      setLoadedScope(requestScope);
    } catch (err) {
      if (scheduleRequestGate.current.isLatest(ticket)) {
        setError((err as Error).message);
        setShifts([]);
      }
    } finally {
      if (scheduleRequestGate.current.isLatest(ticket)) setIsLoading(false);
    }
  }, [requestedLocationId]);

  useEffect(() => {
    void loadSchedule(selectedDate);
    return () => scheduleRequestGate.current.invalidate();
  }, [loadSchedule, selectedDate]);

  const isCurrentScope = isPrintScheduleScopeCurrent(loadedScope, selectedScope);
  const rows = useMemo(
    () => isCurrentScope ? shifts.map((shift) => shiftToPrintRow(shift, timeZone)) : [],
    [isCurrentScope, shifts, timeZone],
  );
  const paddedRows = useMemo<Array<PrintRow | null>>(() => {
    const next: Array<PrintRow | null> = [...rows];
    while (next.length < MIN_SCHEDULE_ROWS) next.push(null);
    return next;
  }, [rows]);

  useEffect(() => {
    if (autoPrintDone || isLoading || !isCurrentScope || error || rows.length === 0) return;
    if (searchParams.get('autoprint') !== '1') return;
    setAutoPrintDone(true);
    window.setTimeout(() => window.print(), 250);
  }, [autoPrintDone, error, isCurrentScope, isLoading, rows.length, searchParams]);

  const selectDate = useCallback((dateValue: string) => {
    scheduleRequestGate.current.invalidate();
    setSelectedDate(dateValue);
    setLoadedScope(null);
    setShifts([]);
    setError(null);
    setIsLoading(true);
  }, []);

  return (
    <>
      <main className="print-shell">
        <div className="print-toolbar no-print">
          <div>
            <strong>Printable schedule</strong>
            <span>{formatDateLabel(selectedDate)}</span>
          </div>
          <label>
            Date
            <input type="date" value={selectedDate} onChange={(event) => selectDate(event.target.value)} />
          </label>
          <Button variant="outline" onClick={() => void loadSchedule(selectedDate)} disabled={isLoading}>
            <RefreshCw size={14} />
            Reload
          </Button>
          <Button onClick={() => window.print()} disabled={isLoading || !isCurrentScope || rows.length === 0}>
            <Printer size={14} />
            Print
          </Button>
          <Button variant="ghost" onClick={() => window.location.assign('/dashboard/scheduling')}>
            <ArrowLeft size={14} />
            Calendar
          </Button>
        </div>

        {error ? <div className="print-status no-print">{error}</div> : null}
        {!error && !isLoading && rows.length === 0 ? <div className="print-status no-print">No schedule rows found for this date.</div> : null}

        <section className="print-page" aria-label="Printable staff schedule">
          <h1>Staff Schedule - {formatDateLabel(selectedDate)}</h1>
          <div className="layout-grid">
            <section className="layout-column-left">
              <div className="card schedule-card">
                <div className="card-header">Schedule</div>
                <div className="card-body">
                  <table className="schedule-table">
                    <colgroup>
                      <col style={{ width: '24%' }} />
                      <col style={{ width: '16%' }} />
                      <col style={{ width: '8%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '16%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Employee</th>
                        <th>Shift</th>
                        <th className="center">POS #</th>
                        <th>Break 1</th>
                        <th>Lunch</th>
                        <th>Break 2</th>
                        <th>Chores</th>
                      </tr>
                    </thead>
                    <tbody>
                      {paddedRows.map((row, index) => (
                        <tr key={row?.id ?? `blank-${index}`} className={index % 2 ? 'row-even' : 'row-odd'}>
                          <td>{row?.employee ?? ''}</td>
                          <td className="nowrap">{row?.shift ?? ''}</td>
                          <td className="center">{row?.pos ?? ''}</td>
                          <td className="nowrap">{row?.break1 ?? ''}</td>
                          <td className="nowrap">{row?.lunch ?? ''}</td>
                          <td className="nowrap">{row?.break2 ?? ''}</td>
                          <td className="chores-cell" />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>

            <section className="layout-column-right">
              <div className="card side-card">
                <div className="card-header">Tip Tracker</div>
                <div className="card-body">
                  <table className="side-table tip-table">
                    <thead>
                      <tr>
                        <th>Bag#</th>
                        <th>Amt</th>
                        <th>Init</th>
                        <th>Time</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: TIP_ROWS }, (_, index) => (
                        <tr key={`tip-${index}`}>
                          <td />
                          <td />
                          <td />
                          <td />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>

              <div className="card side-card">
                <div className="card-header">Training</div>
                <div className="card-body">
                  <table className="side-table training-table">
                    <colgroup>
                      <col style={{ width: '34%' }} />
                      <col style={{ width: '33%' }} />
                      <col style={{ width: '33%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th>Trainee</th>
                        <th>Trainer</th>
                        <th>Topic</th>
                      </tr>
                    </thead>
                    <tbody>
                      {Array.from({ length: TRAINING_ROWS }, (_, index) => (
                        <tr key={`training-${index}`}>
                          <td />
                          <td />
                          <td />
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              </div>
            </section>
          </div>
        </section>
      </main>

      <style jsx>{`
        .print-shell {
          min-height: 100vh;
          background: #e5e7eb;
          color: #000;
          padding: 18px;
          font-family: Helvetica, Arial, sans-serif;
        }

        .print-toolbar {
          max-width: 11in;
          margin: 0 auto 12px;
          border: 1px solid #cbd5e1;
          border-radius: 10px;
          background: #fff;
          padding: 10px;
          display: flex;
          align-items: center;
          gap: 10px;
          flex-wrap: wrap;
          box-shadow: 0 6px 24px rgba(15, 23, 42, 0.08);
        }

        .print-toolbar > div {
          display: grid;
          gap: 2px;
          margin-right: auto;
        }

        .print-toolbar span {
          color: #64748b;
          font-size: 12px;
        }

        .print-toolbar label {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          color: #475569;
          font-size: 12px;
          font-weight: 700;
        }

        .print-toolbar input {
          height: 32px;
          border: 1px solid #cbd5e1;
          border-radius: 8px;
          padding: 0 8px;
          color: #0f172a;
        }

        .print-status {
          max-width: 11in;
          margin: 0 auto 12px;
          border: 1px solid #fecaca;
          border-radius: 8px;
          background: #fff1f2;
          color: #b91c1c;
          padding: 10px 12px;
          font-weight: 700;
        }

        .print-page {
          width: 11in;
          min-height: 8.5in;
          margin: 0 auto;
          background: #fff;
          padding: 0.25in;
          box-shadow: 0 12px 40px rgba(15, 23, 42, 0.16);
        }

        h1 {
          font-size: 16pt;
          text-align: center;
          margin: 0 0 8pt;
          font-weight: 700;
        }

        .layout-grid {
          display: grid;
          grid-template-columns: 70% 30%;
          gap: 8pt;
          align-items: start;
        }

        .layout-column-right {
          display: grid;
          gap: 8pt;
        }

        .card {
          border: 1px solid #000;
          break-inside: avoid;
          page-break-inside: avoid;
          background: #fff;
        }

        .card-header {
          border-bottom: 1px solid #000;
          background: #f2f2f2;
          font-weight: 700;
          font-size: 10pt;
          padding: 4pt 6pt;
        }

        table {
          width: 100%;
          border-collapse: collapse;
          table-layout: fixed;
        }

        th,
        td {
          border: 0.75pt solid #000;
          padding: 2pt 4pt;
          font-size: 8.5pt;
          line-height: 1.2;
          vertical-align: middle;
          word-break: break-word;
        }

        th {
          background: #f2f2f2;
          font-weight: 700;
          text-align: left;
        }

        .schedule-table th,
        .schedule-table td {
          height: 24px;
        }

        .side-table th,
        .side-table td {
          height: 24px;
          text-align: center;
        }

        .center {
          text-align: center;
        }

        .nowrap {
          white-space: nowrap;
        }

        .chores-cell {
          vertical-align: top;
        }

        .row-even td {
          background: #fafafa;
        }

        @page {
          size: Letter landscape;
          margin: 0.25in;
        }

        @media print {
          html,
          body {
            margin: 0;
            background: #fff !important;
          }

          .no-print {
            display: none !important;
          }

          .print-shell {
            min-height: auto;
            padding: 0;
            background: #fff !important;
          }

          .print-page {
            width: auto;
            min-height: auto;
            margin: 0;
            padding: 0;
            box-shadow: none;
          }

          *,
          th,
          td {
            -webkit-print-color-adjust: exact !important;
            print-color-adjust: exact !important;
          }
        }
      `}</style>
    </>
  );
}

export default function PrintSchedulePage() {
  return (
    <Suspense fallback={<main className="print-shell">Loading printable schedule...</main>}>
      <PrintScheduleView />
    </Suspense>
  );
}
