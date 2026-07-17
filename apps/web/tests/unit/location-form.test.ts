import { describe, expect, it } from 'vitest';
import {
  buildLocationCreatePayload,
  buildLocationUpdatePayload,
  getIanaTimeZoneOptions,
  persistedLocationFormValues,
  resolveBrowserIanaTimeZone,
} from '../../app/dashboard/locations/location-form';

describe('location form timezone contract', () => {
  it('uses the browser-resolved IANA timezone only when it is valid', () => {
    expect(resolveBrowserIanaTimeZone(() => ' America/Denver ')).toBe('America/Denver');
    expect(resolveBrowserIanaTimeZone(() => 'Mars/Olympus')).toBe('');
    expect(resolveBrowserIanaTimeZone(() => { throw new Error('unavailable'); })).toBe('');
  });

  it('offers valid browser-supported and current IANA timezones without duplicates', () => {
    const options = getIanaTimeZoneOptions(['America/Los_Angeles', 'America/Los_Angeles', 'Invalid/Zone']);

    expect(options).toContain('America/Los_Angeles');
    expect(options.filter((timezone) => timezone === 'America/Los_Angeles')).toHaveLength(1);
    expect(options).not.toContain('Invalid/Zone');
  });

  it('builds explicit valid non-Eastern timezone request payloads for both forms', () => {
    expect(buildLocationCreatePayload({
      name: ' Westside Cafe ',
      address: ' 100 Pacific Ave ',
      timezone: ' America/Los_Angeles ',
    })).toEqual({
      name: 'Westside Cafe',
      address: '100 Pacific Ave',
      timezone: 'America/Los_Angeles',
    });

    expect(buildLocationUpdatePayload({
      name: ' Westside Cafe ',
      address: ' ',
      timezone: 'America/Los_Angeles',
    })).toEqual({
      name: 'Westside Cafe',
      address: null,
      timezone: 'America/Los_Angeles',
    });
  });

  it('rebuilds every edit draft from the persisted location values', () => {
    const persisted = {
      name: 'Launch Cafe',
      address: '500 Market Street',
      timezone: 'America/Chicago',
    };

    expect(persistedLocationFormValues(persisted)).toEqual(persisted);
    expect(persistedLocationFormValues({
      name: 'No Address Cafe',
      address: null,
      timezone: 'America/Los_Angeles',
    })).toEqual({
      name: 'No Address Cafe',
      address: '',
      timezone: 'America/Los_Angeles',
    });
  });

  it.each(['', '   ', 'Not/A_Real_Zone'])('rejects missing or invalid timezone %j before request creation', (timezone) => {
    expect(() => buildLocationCreatePayload({ name: 'Cafe', address: '', timezone })).toThrow(/timezone/i);
    expect(() => buildLocationUpdatePayload({ name: 'Cafe', address: '', timezone })).toThrow(/timezone/i);
  });
});
