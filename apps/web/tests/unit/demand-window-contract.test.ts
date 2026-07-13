import { describe, expect, it } from 'vitest';
import {
  demandWindowDraft,
  serializeDemandWindowDrafts,
} from '../../app/dashboard/scheduling/demand-window-contract';
import {
  localTimeWindowFromInstants,
  serializeLocalTimeWindow,
} from '../../app/dashboard/scheduling/local-time-window';

describe('schedule demand editor contract', () => {
  it('serializes exact location-local demand windows', () => {
    expect(serializeDemandWindowDrafts([{
      key: 'draft-1', date: '2026-03-09', startTime: '09:30', endTime: '12:00', requiredStaff: '2', skill: ' Cashier ',
    }], 'America/Los_Angeles')).toEqual([{
      startTime: '2026-03-09T16:30:00.000Z', endTime: '2026-03-09T19:00:00.000Z', requiredStaff: 2, skill: 'cashier',
    }]);
  });

  it('does not invent times for an incomplete window', () => {
    expect(() => serializeDemandWindowDrafts([{
      key: 'draft-1', date: '2026-03-09', startTime: '', endTime: '', requiredStaff: '1', skill: '',
    }], 'UTC')).toThrow('needs a date, start time, and end time');
  });

  it('serializes an earlier end time on the next local calendar day', () => {
    expect(serializeDemandWindowDrafts([{
      key: 'overnight', date: '2026-07-11', startTime: '22:00', endTime: '02:00', requiredStaff: '3', skill: '',
    }], 'America/Los_Angeles')).toEqual([{
      startTime: '2026-07-12T05:00:00.000Z', endTime: '2026-07-12T09:00:00.000Z', requiredStaff: 3, skill: null,
    }]);
  });

  it('hydrates overnight demand and shift windows with the start date and next-day end time', () => {
    const record = {
      id: 'overnight',
      startTime: '2026-07-12T05:00:00.000Z',
      endTime: '2026-07-12T09:00:00.000Z',
      requiredStaff: 2,
      skill: null,
    };

    expect(demandWindowDraft(record, 'America/Los_Angeles')).toEqual({
      key: 'overnight', date: '2026-07-11', startTime: '22:00', endTime: '02:00', requiredStaff: '2', skill: '',
    });
    expect(localTimeWindowFromInstants(record.startTime, record.endTime, 'America/Los_Angeles')).toEqual({
      date: '2026-07-11', startTime: '22:00', endTime: '02:00',
    });
  });

  it('converts each overnight endpoint with its DST-specific offset', () => {
    expect(serializeLocalTimeWindow({
      date: '2026-03-07', startTime: '22:00', endTime: '03:00',
    }, 'America/Los_Angeles')).toEqual({
      startTime: '2026-03-08T06:00:00.000Z',
      endTime: '2026-03-08T10:00:00.000Z',
    });
  });

  it('keeps equal times invalid', () => {
    expect(() => serializeLocalTimeWindow({
      date: '2026-07-11', startTime: '22:00', endTime: '22:00',
    }, 'America/Los_Angeles')).toThrow('End time must be after start time.');
  });

  it('rejects an ambiguous fallback wall time for shift windows', () => {
    expect(() => serializeLocalTimeWindow({
      date: '2026-11-01', startTime: '01:30', endTime: '03:00',
    }, 'America/Los_Angeles')).toThrow('ambiguous during the daylight-saving fallback');
  });

  it('rejects an ambiguous fallback wall time for demand windows', () => {
    expect(() => serializeDemandWindowDrafts([{
      key: 'fallback', date: '2026-11-01', startTime: '00:30', endTime: '01:30', requiredStaff: '1', skill: '',
    }], 'America/Los_Angeles')).toThrow('Demand window 1 local date/time is ambiguous');
  });
});
