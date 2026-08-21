import type { RevenueCatEnvironment } from './config.js';

export type HabitKind =
  | 'WATER'
  | 'READING'
  | 'MEDITATION'
  | 'STUDY'
  | 'JOURNALING'
  | 'STRETCHING'
  | 'BED'
  | 'STEPS'
  | 'CALORIES'
  | 'EXERCISE_MINUTES'
  | 'SLEEP_MINUTES'
  | 'CUSTOM';
export type SavableHabitKind = Exclude<HabitKind, 'CUSTOM'>;
export type HabitUnit = 'MILLILITRES' | 'MINUTES' | 'COUNT' | 'CHECKMARK' | 'KILOCALORIES';
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
  stepValue: number;
  unit: HabitUnit;
  weekdays: number[];
  deadlineMinutes: number;
  timezone: string;
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
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface SaveHabitCommand {
  userId: string;
  habitId: string;
  kind: SavableHabitKind;
  title: string;
  targetValue: number;
  stepValue: number;
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
  /**
   * The server-issued calendar date the progress belongs to. Older clients
   * omit this and retain the original occurredAt-derived, today-only flow.
   */
  targetLocalDate?: string | undefined;
}

export interface HabitProgressResult {
  accepted: boolean;
  duplicate: boolean;
  completed: boolean;
  localDate: string;
  progressValue: number;
  targetValue: number;
  status: HabitOccurrenceStatus;
  serverTimestamp: string;
}

export interface HabitSettlementResult {
  duplicate: boolean;
  status: HabitOccurrenceStatus;
}

export interface HabitView extends HabitDefinition {
  scheduledToday: boolean;
  todayProgress: number;
  todayStatus: HabitOccurrenceStatus | 'NOT_SCHEDULED';
  todayDueAt: string | undefined;
  /** Fixed server-configured points earned after a successful completion. */
  completionAwardPoints: number;
}

export interface HabitDayView extends HabitDefinition {
  localDate: string;
  progressValue: number;
  status: HabitOccurrenceStatus;
  dueAt: string;
  editableUntil: string;
  editable: boolean;
  /** Fixed server-configured points earned after a successful completion. */
  completionAwardPoints: number;
}

export function defaultHabitStepValue(kind: HabitKind): number {
  switch (kind) {
    case 'WATER':
      return 250;
    case 'READING':
    case 'MEDITATION':
    case 'STUDY':
      return 10;
    case 'JOURNALING':
    case 'STRETCHING':
      return 5;
    case 'BED':
      return 1;
    case 'STEPS':
      return 500;
    case 'CALORIES':
    case 'EXERCISE_MINUTES':
    case 'SLEEP_MINUTES':
      return 1;
    case 'CUSTOM':
      return 1;
  }
}
