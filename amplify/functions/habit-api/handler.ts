import type { AppSyncIdentity } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import {
  awardConfigurationFromEnvironment,
  awardPointsForHabit,
  configuredEnvironment,
  type AwardConfiguration,
} from '../../shared/config.js';
import {
  DynamoEarnedPointsRepository,
  earnedPointsTableNamesFromEnvironment,
} from '../../shared/dynamo-earned-points-repository.js';
import type { EarnedPointsRepository } from '../../shared/earned-points-repository.js';
import {
  DynamoHabitRepository,
  habitTableNamesFromEnvironment,
} from '../../shared/dynamo-habit-repository.js';
import { DomainError } from '../../shared/domain.js';
import {
  DynamoRateLimiter,
  NoopRateLimiter,
  rateLimitPolicyFor,
  type RateLimiter,
} from '../../shared/rate-limit.js';
import {
  archiveHabit,
  habitDashboard,
  habitDay,
  habitView,
  localParts,
  reconcileLoweredHabitGoal,
  reportHabitProgress,
  saveHabit,
} from '../../shared/habits.js';
import { defaultHabitStepValue } from '../../shared/habit-types.js';
import type { HabitRepository } from '../../shared/habit-repository.js';
import {
  habitIdArgumentsSchema,
  habitDayArgumentsSchema,
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
  activeState: habit.activeState,
  scheduledToday: habit.scheduledToday,
  todayProgress: habit.todayProgress,
  todayStatus: habit.todayStatus,
  todayDueAt: habit.todayDueAt,
  completionAwardPoints: habit.completionAwardPoints,
  createdAt: habit.createdAt,
  updatedAt: habit.updatedAt,
});

const publicDayHabit = (habit: Awaited<ReturnType<typeof habitDay>>[number]) => ({
  id: habit.id,
  kind: habit.kind,
  title: habit.title,
  targetValue: habit.targetValue,
  stepValue: habit.stepValue,
  unit: habit.unit,
  weekdays: habit.weekdays,
  deadlineMinutes: habit.deadlineMinutes,
  timezone: habit.timezone,
  activeState: habit.activeState,
  localDate: habit.localDate,
  progressValue: habit.progressValue,
  status: habit.status,
  dueAt: habit.dueAt,
  editableUntil: habit.editableUntil,
  editable: habit.editable,
  completionAwardPoints: habit.completionAwardPoints,
  createdAt: habit.createdAt,
  updatedAt: habit.updatedAt,
});

export async function handleHabitApiEvent(
  event: HabitApiEvent,
  repository: HabitRepository,
  now = new Date().toISOString(),
  earnedPoints?: EarnedPointsRepository,
  awards: AwardConfiguration = awardConfigurationFromEnvironment(),
  rateLimiter: RateLimiter = new NoopRateLimiter(),
): Promise<unknown> {
  const userId = cognitoSub(event.identity);
  const rateLimitPolicy = rateLimitPolicyFor(event.fieldName);
  if (rateLimitPolicy !== undefined) await rateLimiter.check(userId, rateLimitPolicy);
  switch (event.fieldName) {
    case 'getMyHabits': {
      let dashboard = await habitDashboard(repository, userId, now, awards);
      const stuck = dashboard.filter(
        (habit) =>
          habit.scheduledToday &&
          habit.todayStatus === 'PENDING' &&
          habit.todayProgress >= habit.targetValue,
      );
      for (const view of stuck) {
        const habit = await repository.getHabit(userId, view.id);
        if (habit === undefined) continue;
        const result = await reconcileLoweredHabitGoal(repository, habit, now);
        if (result?.completed === true) {
          if (earnedPoints === undefined) throw new DomainError('EARNED_POINTS_UNAVAILABLE');
          await earnedPoints.earnPoints(
            {
              userId,
              qualification: 'HABIT_COMPLETION',
              sourceEventId: `${habit.id}:${result.localDate}`,
              points: awardPointsForHabit(habit.kind, awards),
            },
            now,
          );
        }
      }
      if (stuck.length > 0) dashboard = await habitDashboard(repository, userId, now, awards);
      return dashboard.map(publicHabit);
    }
    case 'getMyHabitDay': {
      const input = habitDayArgumentsSchema.parse(event.arguments);
      const habits = await habitDay(repository, userId, input.dayOffset, now, awards);
      return {
        dayOffset: input.dayOffset,
        habits: habits.map(publicDayHabit),
        serverTimestamp: now,
      };
    }
    case 'saveMyHabit': {
      const input = saveHabitArgumentsSchema.parse(event.arguments.input);
      const saved = await saveHabit(
        repository,
        {
          userId,
          ...input,
          stepValue: input.stepValue ?? defaultHabitStepValue(input.kind),
        },
        now,
      );
      await reconcileLoweredHabitGoal(repository, saved, now);
      const view = await habitView(repository, saved, now, awards);
      if (view.todayStatus === 'COMPLETED') {
        if (earnedPoints === undefined) throw new DomainError('EARNED_POINTS_UNAVAILABLE');
        await earnedPoints.earnPoints(
          {
            userId,
            qualification: 'HABIT_COMPLETION',
            sourceEventId: `${saved.id}:${localParts(now, saved.timezone).date}`,
            points: awardPointsForHabit(saved.kind, awards),
          },
          now,
        );
      }
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
      if (earnedPoints === undefined) throw new DomainError('EARNED_POINTS_UNAVAILABLE');
      const input = habitProgressArgumentsSchema.parse(event.arguments.input);
      const result = await reportHabitProgress(repository, { userId, ...input }, now);
      const habit = result.completed ? await repository.getHabit(userId, input.habitId) : undefined;
      if (result.completed && habit === undefined) throw new DomainError('HABIT_NOT_FOUND');
      let earning: { pointsEarned: number; currentPoints: number };
      if (result.completed) {
        if (habit === undefined) throw new DomainError('HABIT_NOT_FOUND');
        earning = await earnedPoints.earnPoints(
          {
            userId,
            qualification: 'HABIT_COMPLETION',
            sourceEventId: `${input.habitId}:${result.localDate}`,
            points: awardPointsForHabit(habit.kind, awards),
          },
          now,
        );
      } else {
        earning = await earnedPoints.getDisciPointAccount(userId, now).then((account) => ({
          pointsEarned: 0,
          currentPoints: account.currentPoints,
        }));
      }
      return {
        ...result,
        pointsAwarded: earning.pointsEarned,
        earnedPointsTotal: earning.currentPoints,
      };
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
  const earnedPoints = new DynamoEarnedPointsRepository(
    earnedPointsTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  return handleHabitApiEvent(
    event,
    repository,
    new Date().toISOString(),
    earnedPoints,
    awardConfigurationFromEnvironment(),
    new DynamoRateLimiter(),
  );
};
