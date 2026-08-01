import type { RevenueCatEnvironment } from './config.js';

export type HabitKind = 'WATER' | 'READING' | 'MEDITATION' | 'CUSTOM';
export type HabitUnit = 'MILLILITRES' | 'MINUTES' | 'COUNT' | 'CHECKMARK';
export type HabitOccurrenceStatus = 'PENDING' | 'COMPLETED' | 'MISSED' | 'SKIPPED_INELIGIBLE';

export interface HabitDefinition {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironment: string;
  environmentState: string;
  kind: HabitKind;
  title: string;
  targetValue: number;
  unit: HabitUnit;
  weekdays: number[];
  deadlineMinutes: number;
  timezone: string;
  penaltyPoints: number;
  startDate: string;
  activeState: 'ACTIVE' | 'ARCHIVED';
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface HabitOccurrence {
  id: string;
  userId: string;
  environment: RevenueCatEnvironment;
  userEnvironmentDate: string;
  habitId: string;
  localDate: string;
  dueAt: string;
  targetValue: number;
  unit: HabitUnit;
  progressValue: number;
  status: HabitOccurrenceStatus;
  completedAt: string | undefined;
  missedAt: string | undefined;
  ledgerTransactionId: string | undefined;
  pointsDeducted: number;
  officialBalance: number;
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveHabitCommand {
  userId: string;
  habitId: string;
  kind: HabitKind;
  title: string;
  targetValue: number;
  unit: HabitUnit;
  weekdays: number[];
  deadlineMinutes: number;
  timezone: string;
}

export interface HabitProgressCommand {
  userId: string;
  habitId: string;
  progressEventId: string;
  amount: number;
  occurredAt: string;
}

export interface HabitProgressResult {
  accepted: boolean;
  duplicate: boolean;
  completed: boolean;
  localDate: string;
  progressValue: number;
  targetValue: number;
  status: HabitOccurrenceStatus;
  officialBalance: number;
  serverTimestamp: string;
}

export interface HabitSettlementResult {
  duplicate: boolean;
  status: HabitOccurrenceStatus;
  pointsDeducted: number;
  officialBalance: number;
}

export interface HabitView extends HabitDefinition {
  scheduledToday: boolean;
  todayProgress: number;
  todayStatus: HabitOccurrenceStatus | 'NOT_SCHEDULED';
  todayDueAt: string | undefined;
}
