import { createHash } from 'node:crypto';

type Window = { locationId: string | null; startTimeMinutes: number; endTimeMinutes: number };

/** Order-independent token for the exact persisted scheduling inputs. */
export function profileVersion(
  userId: string,
  skills: string[],
  availability: Array<Window & { dayOfWeek: number }>,
  exceptions: Array<Window & { localDate: Date; kind: string }>,
): string {
  const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
  return createHash('sha256').update(JSON.stringify([
    userId,
    [...skills].sort(),
    sorted(availability.map(row => [row.locationId, row.dayOfWeek, row.startTimeMinutes, row.endTimeMinutes])),
    sorted(exceptions.map(row => [row.locationId, row.localDate.toISOString().slice(0, 10), row.kind, row.startTimeMinutes, row.endTimeMinutes])),
  ])).digest('hex');
}
