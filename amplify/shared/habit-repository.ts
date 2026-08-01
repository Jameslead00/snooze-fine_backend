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
  saveHabit(
    command: SaveHabitCommand,
    startDate: string,
    penaltyPoints: number,
    now: string,
  ): Promise<HabitDefinition>;
  archiveHabit(userId: string, habitId: string, now: string): Promise<HabitDefinition>;
  recordHabitProgress(input: {
    command: HabitProgressCommand;
    habit: HabitDefinition;
    occurrence: HabitOccurrence;
    now: string;
  }): Promise<HabitProgressResult>;
  listActiveHabits(): Promise<HabitDefinition[]>;
  settleMissedHabit(input: {
    habit: HabitDefinition;
    occurrence: HabitOccurrence;
    now: string;
  }): Promise<HabitSettlementResult>;
  officialBalance(userId: string): Promise<number>;
  listOccurrences(userId: string, localDate: string): Promise<HabitOccurrence[]>;
}
