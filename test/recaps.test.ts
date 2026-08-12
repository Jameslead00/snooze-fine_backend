import { describe, expect, it, vi } from 'vitest';
import type { HabitDefinition, HabitOccurrence } from '../amplify/shared/habit-types.js';
import { weeklyProgressRecap, type WeeklyRecapRepository } from '../amplify/shared/recaps.js';
import type { AccountabilityStatistics } from '../amplify/shared/sync-types.js';

const userId = 'user-1';
const now = '2026-08-05T16:30:00.000Z';

function habit(
  id: string,
  kind: HabitDefinition['kind'],
  weekdays: number[],
  targetValue = 10,
  activeState: HabitDefinition['activeState'] = 'ACTIVE',
): HabitDefinition {
  return {
    id,
    userId,
    environment: 'SANDBOX',
    userEnvironment: `${userId}:SANDBOX`,
    environmentState: `SANDBOX:${activeState}`,
    kind,
    title: kind === 'BED' ? 'Making the bed' : kind,
    targetValue,
    stepValue: Math.min(5, targetValue),
    unit: kind === 'WATER' ? 'MILLILITRES' : kind === 'BED' ? 'CHECKMARK' : 'MINUTES',
    weekdays,
    deadlineMinutes: 1_439,
    timezone: 'Europe/Zurich',
    startDate: '2026-07-01',
    activeState,
    version: 1,
    createdAt: '2026-07-01T00:00:00.000Z',
    updatedAt: '2026-07-01T00:00:00.000Z',
  };
}

function occurrence(
  source: HabitDefinition,
  localDate: string,
  progressValue: number,
  status: HabitOccurrence['status'],
): HabitOccurrence {
  return {
    id: `${source.id}-${localDate}`,
    userId,
    environment: 'SANDBOX',
    userEnvironmentDate: `${userId}:SANDBOX:${localDate}`,
    habitId: source.id,
    localDate,
    dueAt: `${localDate}T23:59:00.000Z`,
    targetValue: source.targetValue,
    unit: source.unit,
    progressValue,
    status,
    completedAt: status === 'COMPLETED' ? `${localDate}T08:00:00.000Z` : undefined,
    missedAt: undefined,
    version: 1,
    createdAt: `${localDate}T08:00:00.000Z`,
    updatedAt: `${localDate}T08:00:00.000Z`,
  };
}

function statistics(): AccountabilityStatistics {
  return {
    todayNoSnoozeMorning: true,
    weekSnoozes: 1,
    weekWakeUps: 2,
    weekNoSnoozeMornings: 1,
    allTimeSnoozes: 1,
    allTimeWakeUps: 2,
    allTimeNoSnoozeMornings: 1,
    timezone: 'Europe/Zurich',
    serverTimestamp: now,
  };
}

function repository(
  habits: HabitDefinition[],
  occurrences: HabitOccurrence[],
  recapStatistics: AccountabilityStatistics = statistics(),
): WeeklyRecapRepository {
  return {
    listHabits: vi.fn().mockResolvedValue(habits),
    listOccurrences: vi
      .fn()
      .mockImplementation(async (_userId: string, localDate: string) =>
        occurrences.filter((item) => item.localDate === localDate),
      ),
    statistics: vi.fn().mockResolvedValue(recapStatistics),
  };
}

describe('weekly progress recaps', () => {
  it('aggregates elapsed days using goal progress and completed promises', async () => {
    const water = habit('water', 'WATER', [1, 2, 3], 1_000);
    const reading = habit('reading', 'READING', [1, 3], 10);
    const bed = habit('bed', 'BED', [1, 2, 3], 1);
    const result = await weeklyProgressRecap(
      repository(
        [
          water,
          reading,
          bed,
          habit('legacy-custom', 'CUSTOM', [1, 2, 3]),
          habit('archived', 'MEDITATION', [1, 2, 3], 10, 'ARCHIVED'),
        ],
        [
          occurrence(water, '2026-08-03', 1_000, 'COMPLETED'),
          occurrence(water, '2026-08-04', 500, 'PENDING'),
          occurrence(reading, '2026-08-03', 10, 'COMPLETED'),
          occurrence(reading, '2026-08-05', 10, 'COMPLETED'),
        ],
      ),
      userId,
      now,
    );

    expect(result).toMatchObject({
      period: 'WEEK',
      periodStart: '2026-08-03',
      periodEnd: '2026-08-05',
      includedDays: 3,
      timezone: 'Europe/Zurich',
      days: [
        { date: '2026-08-03', promisesScheduled: 3, promisesKept: 2, promisesPercentage: 66.67 },
        { date: '2026-08-04', promisesScheduled: 2, promisesKept: 0, promisesPercentage: 0 },
        { date: '2026-08-05', promisesScheduled: 3, promisesKept: 1, promisesPercentage: 33.33 },
      ],
      promisesScheduled: 8,
      promisesKept: 3,
      promisesPercentage: 37.5,
      wakeUps: 2,
      noSnoozeMornings: 1,
    });
    expect(result.habits).toEqual([
      expect.objectContaining({
        kind: 'WATER',
        scheduledDays: 3,
        completedDays: 1,
        progressValue: 1_500,
        targetValue: 3_000,
        progressPercentage: 50,
      }),
      expect.objectContaining({
        kind: 'READING',
        scheduledDays: 2,
        completedDays: 2,
        progressValue: 20,
        targetValue: 20,
        progressPercentage: 100,
      }),
      expect.objectContaining({
        kind: 'BED',
        scheduledDays: 3,
        completedDays: 0,
        progressPercentage: 0,
      }),
    ]);
  });

  it('uses the user timezone when the UTC date is still the prior local day', async () => {
    const localMidnight = '2026-08-02T22:30:00.000Z';
    const water = habit('water', 'WATER', [1], 1_000);
    const source = repository([water], [], {
      ...statistics(),
      serverTimestamp: localMidnight,
    });

    const result = await weeklyProgressRecap(source, userId, localMidnight);

    expect(result.periodStart).toBe('2026-08-03');
    expect(result.periodEnd).toBe('2026-08-03');
    expect(result.includedDays).toBe(1);
  });
});
