import type {
  HabitDefinition,
  HabitOccurrence,
  HabitProgressCommand,
  HabitProgressResult,
  HabitSettlementResult,
  SaveHabitCommand,
} from './habit-types.js';

export interface HabitRepository {
  listHabits(userId: string): Promise<HabitDefinition[]>;
  getHabit(userId: string, habitId: string): Promise<HabitDefinition | undefined>;
  saveHabit(command: SaveHabitCommand, startDate: string, now: string): Promise<HabitDefinition>;
  archiveHabit(userId: string, habitId: string, now: string): Promise<HabitDefinition>;
  recordHabitProgress(input: {
    command: HabitProgressCommand;
    habit: HabitDefinition;
    occurrence: HabitOccurrence;
    now: string;
    allowMissedReopen?: boolean;
  }): Promise<HabitProgressResult>;
  listActiveHabits(): Promise<HabitDefinition[]>;
  settleMissedHabit(input: {
    habit: HabitDefinition;
    occurrence: HabitOccurrence;
    now: string;
  }): Promise<HabitSettlementResult>;
  listOccurrences(userId: string, localDate: string): Promise<HabitOccurrence[]>;
}
