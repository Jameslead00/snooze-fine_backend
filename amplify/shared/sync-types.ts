import type { RevenueCatEnvironment } from './config.js';

export interface SyncedAlarm {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  hour: number;
  minute: number;
  repeatWeekdays: number[];
  snoozeDurationMinutes: number;
  label: string;
  isEnabled: boolean;
  timezone: string;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveSyncedAlarmCommand {
  userId: string;
  alarmId: string;
  expectedVersion: number;
  hour: number;
  minute: number;
  repeatWeekdays: number[];
  snoozeDurationMinutes: number;
  label: string;
  isEnabled: boolean;
  timezone: string;
}

export interface WakeCompletion {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  alarmId: string;
  alarmOccurrenceId: string;
  scheduledAt: string;
  completedAt: string;
  snoozeCount: number;
  createdAt: string;
}

export interface RecordWakeCommand {
  userId: string;
  wakeEventId: string;
  alarmId: string;
  alarmOccurrenceId: string;
  scheduledAt: string;
  completedAt: string;
  snoozeCount: number;
}

export interface AccountabilityStatistics {
  todayNoSnoozeMorning: boolean;
  weekSnoozes: number;
  weekWakeUps: number;
  weekNoSnoozeMornings: number;
  allTimeSnoozes: number;
  allTimeWakeUps: number;
  allTimeNoSnoozeMornings: number;
  timezone: string;
  serverTimestamp: string;
}
