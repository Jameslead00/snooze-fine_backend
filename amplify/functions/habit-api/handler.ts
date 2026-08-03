import type { AppSyncIdentity } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoHabitRepository,
  habitTableNamesFromEnvironment,
} from '../../shared/dynamo-habit-repository.js';
import { DomainError } from '../../shared/domain.js';
import {
  archiveHabit,
  habitDashboard,
  habitView,
  reportHabitProgress,
  saveHabit,
} from '../../shared/habits.js';
import type { HabitRepository } from '../../shared/habit-repository.js';
import {
  habitIdArgumentsSchema,
  habitProgressArgumentsSchema,
  saveHabitArgumentsSchema,
} from '../../shared/validation.js';

export interface HabitApiEvent {
  fieldName: string;
  arguments: Record<string, unknown>;
  identity: AppSyncIdentity | null;
}

const publicHabit = (habit: Awaited<ReturnType<typeof habitDashboard>>[number]) => ({
  id: habit.id,
  kind: habit.kind,
  title: habit.title,
  targetValue: habit.targetValue,
  stepValue: habit.stepValue,
  unit: habit.unit,
  weekdays: habit.weekdays,
  deadlineMinutes: habit.deadlineMinutes,
  timezone: habit.timezone,
  penaltyPoints: habit.penaltyPoints,
  activeState: habit.activeState,
  scheduledToday: habit.scheduledToday,
  todayProgress: habit.todayProgress,
  todayStatus: habit.todayStatus,
  todayDueAt: habit.todayDueAt,
  createdAt: habit.createdAt,
  updatedAt: habit.updatedAt,
});

export async function handleHabitApiEvent(
  event: HabitApiEvent,
  repository: HabitRepository,
  now = new Date().toISOString(),
): Promise<unknown> {
  const userId = cognitoSub(event.identity);
  switch (event.fieldName) {
    case 'getMyHabits':
      return (await habitDashboard(repository, userId, now)).map(publicHabit);
    case 'saveMyHabit': {
      const input = saveHabitArgumentsSchema.parse(event.arguments.input);
      const saved = await saveHabit(repository, { userId, ...input }, now);
      const view = await habitView(repository, saved, now);
      return publicHabit(view);
    }
    case 'archiveMyHabit': {
      const input = habitIdArgumentsSchema.parse(event.arguments);
      const habit = await archiveHabit(repository, userId, input.habitId, now);
      return {
        id: habit.id,
        archived: habit.activeState === 'ARCHIVED',
        serverTimestamp: now,
      };
    }
    case 'reportHabitProgress': {
      const input = habitProgressArgumentsSchema.parse(event.arguments.input);
      return reportHabitProgress(repository, { userId, ...input }, now);
    }
    default:
      throw new DomainError('UNSUPPORTED_OPERATION');
  }
}

export const handler = async (event: HabitApiEvent): Promise<unknown> => {
  const repository = new DynamoHabitRepository(
    habitTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  return handleHabitApiEvent(event, repository);
};
