import type {
  AccountabilityStatistics,
  RecordWakeCommand,
  SaveSyncedAlarmCommand,
  SyncedAlarm,
  WakeCompletion,
} from './sync-types.js';

export interface SyncRepository {
  listAlarms: (userId: string) => Promise<SyncedAlarm[]>;
  saveAlarm: (command: SaveSyncedAlarmCommand, now: string) => Promise<SyncedAlarm>;
  archiveAlarm: (
    userId: string,
    alarmId: string,
    expectedVersion: number,
    now: string,
  ) => Promise<SyncedAlarm>;
  recordWake: (
    command: RecordWakeCommand,
    now: string,
  ) => Promise<{ event: WakeCompletion; duplicate: boolean }>;
  statistics: (userId: string, now: string) => Promise<AccountabilityStatistics>;
}
