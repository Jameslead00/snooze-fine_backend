import { describe, expect, it } from 'vitest';
import type { AppSyncIdentity } from 'aws-lambda';
import { handleHabitApiEvent } from '../amplify/functions/habit-api/handler.js';
import { awardConfigurationFromEnvironment } from '../amplify/shared/config.js';
import { InMemoryHabitRepository } from './support/in-memory-habit-repository.js';

const userId = '11111111-1111-4111-8111-111111111111';
const habitId = '22222222-2222-4222-8222-222222222222';
const now = '2026-07-31T12:00:00.000Z';

class EventuallyConsistentHabitRepository extends InMemoryHabitRepository {
  override async listHabits(_userId: string) {
    return [];
  }
}

describe('habit API', () => {
  it('returns the authoritative saved habit even when the habit GSI is briefly stale', async () => {
    const repository = new EventuallyConsistentHabitRepository();
    const result = (await handleHabitApiEvent(
      {
        fieldName: 'saveMyHabit',
        arguments: {
          input: {
            habitId,
            kind: 'WATER',
            title: 'Drink water',
            targetValue: 2_000,
            stepValue: 33,
            unit: 'MILLILITRES',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            deadlineMinutes: 1_320,
            timezone: 'Europe/Zurich',
          },
        },
        identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
      },
      repository,
      now,
    )) as {
      id: string;
      title: string;
      targetValue: number;
      stepValue: number;
      scheduledToday: boolean;
      completionAwardPoints: number;
    };

    expect(result).toMatchObject({
      id: habitId,
      title: 'Drink water',
      targetValue: 2_000,
      stepValue: 33,
      scheduledToday: true,
      completionAwardPoints: awardConfigurationFromEnvironment().habits.WATER,
    });
  });

  it('exposes the fixed positive completion award on every returned habit view', async () => {
    const repository = new InMemoryHabitRepository();
    await handleHabitApiEvent(
      {
        fieldName: 'saveMyHabit',
        arguments: {
          input: {
            habitId,
            kind: 'WATER',
            title: 'Drink water',
            targetValue: 2_000,
            stepValue: 250,
            unit: 'MILLILITRES',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            deadlineMinutes: 1_320,
            timezone: 'Europe/Zurich',
          },
        },
        identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
      },
      repository,
      now,
    );

    const habits = (await handleHabitApiEvent(
      {
        fieldName: 'getMyHabits',
        arguments: {},
        identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
      },
      repository,
      now,
    )) as Array<{ completionAwardPoints: number }>;

    expect(habits).toEqual([
      expect.objectContaining({
        completionAwardPoints: awardConfigurationFromEnvironment().habits.WATER,
      }),
    ]);
    expect(habits[0]?.completionAwardPoints).toBeGreaterThan(0);
  });

  it('surfaces a server-configured award amount in habit views', async () => {
    const repository = new InMemoryHabitRepository();
    const result = (await handleHabitApiEvent(
      {
        fieldName: 'saveMyHabit',
        arguments: {
          input: {
            habitId,
            kind: 'BED',
            title: 'Make the bed',
            targetValue: 1,
            stepValue: 1,
            unit: 'CHECKMARK',
            weekdays: [1],
            deadlineMinutes: 1_000,
            timezone: 'Europe/Zurich',
          },
        },
        identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
      },
      repository,
      now,
      undefined,
      {
        wakeCompletion: 40,
        habits: { WATER: 7, READING: 8, MEDITATION: 9, BED: 3, STEPS: 11, CUSTOM: 1 },
      },
    )) as { completionAwardPoints: number };
    expect(result.completionAwardPoints).toBe(3);
  });

  it('accepts the fixed BED habit kind through the GraphQL input contract', async () => {
    const repository = new InMemoryHabitRepository();
    const result = (await handleHabitApiEvent(
      {
        fieldName: 'saveMyHabit',
        arguments: {
          input: {
            habitId,
            kind: 'BED',
            title: 'Making the bed',
            targetValue: 1,
            stepValue: 1,
            unit: 'CHECKMARK',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            deadlineMinutes: 1_439,
            timezone: 'Europe/Zurich',
          },
        },
        identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
      },
      repository,
      now,
    )) as { kind: string; title: string };

    expect(result).toMatchObject({ kind: 'BED', title: 'Making the bed' });
  });

  it('rejects CUSTOM as a new habit kind', async () => {
    const repository = new InMemoryHabitRepository();

    await expect(
      handleHabitApiEvent(
        {
          fieldName: 'saveMyHabit',
          arguments: {
            input: {
              habitId,
              kind: 'CUSTOM',
              title: 'Journal',
              targetValue: 1,
              stepValue: 1,
              unit: 'CHECKMARK',
              weekdays: [1, 2, 3, 4, 5, 6, 7],
              deadlineMinutes: 1_439,
              timezone: 'Europe/Zurich',
            },
          },
          identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
        },
        repository,
        now,
      ),
    ).rejects.toThrow();
  });

  it('accepts the STEPS habit kind through the GraphQL input contract', async () => {
    const repository = new InMemoryHabitRepository();
    const result = (await handleHabitApiEvent(
      {
        fieldName: 'saveMyHabit',
        arguments: {
          input: {
            habitId,
            kind: 'STEPS',
            title: 'Steps',
            targetValue: 10_000,
            stepValue: 500,
            unit: 'COUNT',
            weekdays: [1, 2, 3, 4, 5, 6, 7],
            deadlineMinutes: 1_439,
            timezone: 'Europe/Zurich',
          },
        },
        identity: { claims: { sub: userId } } as unknown as AppSyncIdentity,
      },
      repository,
      now,
    )) as { kind: string; unit: string; targetValue: number };

    expect(result).toMatchObject({ kind: 'STEPS', unit: 'COUNT', targetValue: 10_000 });
  });
});
