import type { StaffSchedulingProfile, StaffSchedulingProfileRequest } from '@lunchlineup/api-contract';

/** Every callback, including completion, must still own its editor operation. */
export class ProfileOperationOwner {
    private generation = 0;
    begin() { return ++this.generation; }
    owns(token: number) { return this.generation === token; }
    invalidate() { this.generation += 1; }
}

export function profileMatchesDraft(profile: StaffSchedulingProfile, draft: StaffSchedulingProfileRequest): boolean {
    const sorted = (rows: unknown[]) => rows.map(row => JSON.stringify(row)).sort();
    const contents = (value: StaffSchedulingProfileRequest | StaffSchedulingProfile) => JSON.stringify([
        [...value.skills].sort(),
        sorted(value.availability.map(row => [row.locationId, row.dayOfWeek, row.startTimeMinutes, row.endTimeMinutes])),
        sorted((value.availabilityExceptions ?? []).map(row => [row.locationId, row.date, row.kind, row.allDay, row.startTimeMinutes, row.endTimeMinutes])),
    ]);
    return contents(profile) === contents(draft);
}
