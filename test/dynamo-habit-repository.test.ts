import type { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoHabitRepository } from '../amplify/shared/dynamo-habit-repository.js';

const tables = {
  habit: 'habits',
  occurrence: 'occurrences',
  progressEvent: 'progress-events',
};

const habitItem = (id: string, updatedAt: string) => ({
  id,
  userId: 'user-1',
  environment: 'SANDBOX',
  userEnvironment: 'user-1:SANDBOX',
  environmentState: 'SANDBOX:ACTIVE',
  kind: 'WATER',
  title: `Habit ${id}`,
  targetValue: 2_000,
  stepValue: 250,
  unit: 'MILLILITRES',
  weekdays: [1, 2, 3, 4, 5, 6, 7],
  deadlineMinutes: 1_320,
  timezone: 'Europe/Zurich',
  startDate: '2026-07-01',
  activeState: 'ACTIVE',
  version: 1,
  createdAt: '2026-07-01T00:00:00.000Z',
  updatedAt,
});

describe('Dynamo habit pagination', () => {
  it('reads every active-habit query page for scheduled enforcement', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({
        Items: [habitItem('habit-1', '2026-07-01T00:00:00.000Z')],
        LastEvaluatedKey: { id: 'habit-1' },
      })
      .mockResolvedValueOnce({
        Items: [habitItem('habit-2', '2026-07-02T00:00:00.000Z')],
      });
    const repository = new DynamoHabitRepository(tables, 'SANDBOX', {
      send,
    } as unknown as DynamoDBDocumentClient);

    const habits = await repository.listActiveHabits();

    expect(habits.map((habit) => habit.id)).toEqual(['habit-1', 'habit-2']);
    expect(send).toHaveBeenCalledTimes(2);
    const secondCommand = send.mock.calls[1]?.[0] as QueryCommand;
    expect(secondCommand.input.ExclusiveStartKey).toEqual({ id: 'habit-1' });
  });
});
