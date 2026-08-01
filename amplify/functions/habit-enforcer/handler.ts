import type { ScheduledEvent } from 'aws-lambda';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoHabitRepository,
  habitTableNamesFromEnvironment,
} from '../../shared/dynamo-habit-repository.js';
import { dueLocalDates, settleHabit } from '../../shared/habits.js';
import type { HabitRepository } from '../../shared/habit-repository.js';
import { log } from '../../shared/logger.js';

export interface HabitEnforcementSummary {
  habitsChecked: number;
  occurrencesChecked: number;
  newlyMissed: number;
  skippedIneligible: number;
  pointsDeducted: number;
}

export async function enforceDueHabits(
  repository: HabitRepository,
  now = new Date().toISOString(),
): Promise<HabitEnforcementSummary> {
  const habits = await repository.listActiveHabits();
  const summary: HabitEnforcementSummary = {
    habitsChecked: habits.length,
    occurrencesChecked: 0,
    newlyMissed: 0,
    skippedIneligible: 0,
    pointsDeducted: 0,
  };
  for (const habit of habits) {
    for (const localDate of dueLocalDates(habit, now)) {
      summary.occurrencesChecked += 1;
      const result = await settleHabit(repository, habit, localDate, now);
      if (!result.duplicate && result.status === 'MISSED') summary.newlyMissed += 1;
      if (!result.duplicate && result.status === 'SKIPPED_INELIGIBLE') {
        summary.skippedIneligible += 1;
      }
      if (!result.duplicate) summary.pointsDeducted += result.pointsDeducted;
    }
  }
  return summary;
}

export const handler = async (event: ScheduledEvent): Promise<HabitEnforcementSummary> => {
  const repository = new DynamoHabitRepository(
    habitTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const summary = await enforceDueHabits(repository, event.time);
  log('info', 'habit_enforcement_completed', { ...summary });
  return summary;
};
