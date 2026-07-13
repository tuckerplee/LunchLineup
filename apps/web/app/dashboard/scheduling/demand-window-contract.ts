import { localTimeWindowFromInstants, serializeLocalTimeWindow } from './local-time-window';

export type DemandWindowRecord = {
  id: string;
  startTime: string;
  endTime: string;
  requiredStaff: number;
  skill: string | null;
};

export type DemandWindowDraft = {
  key: string;
  date: string;
  startTime: string;
  endTime: string;
  requiredStaff: string;
  skill: string;
};

export function demandWindowDraft(record: DemandWindowRecord, timeZone: string): DemandWindowDraft {
  const window = localTimeWindowFromInstants(record.startTime, record.endTime, timeZone);
  return {
    key: record.id,
    ...window,
    requiredStaff: String(record.requiredStaff),
    skill: record.skill ?? '',
  };
}

export function emptyDemandWindowDraft(key: string): DemandWindowDraft {
  return { key, date: '', startTime: '', endTime: '', requiredStaff: '1', skill: '' };
}

export function serializeDemandWindowDrafts(drafts: DemandWindowDraft[], timeZone: string) {
  return drafts.map((draft, index) => {
    if (!draft.date || !draft.startTime || !draft.endTime) {
      throw new Error(`Demand window ${index + 1} needs a date, start time, and end time.`);
    }
    const requiredStaff = Number(draft.requiredStaff);
    if (!Number.isInteger(requiredStaff) || requiredStaff < 1 || requiredStaff > 200) {
      throw new Error(`Demand window ${index + 1} required staff must be from 1 to 200.`);
    }
    let window;
    try {
      window = serializeLocalTimeWindow(draft, timeZone);
    } catch (error) {
      throw new Error(`Demand window ${index + 1} ${(error as Error).message.toLowerCase()}`);
    }
    const skill = draft.skill.trim().toLowerCase();
    if (skill.length > 128) throw new Error(`Demand window ${index + 1} skill is too long.`);
    return { ...window, requiredStaff, skill: skill || null };
  });
}
