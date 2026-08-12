import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoSyncRepository } from '../amplify/shared/dynamo-sync-repository.js';

const tables = {
  alarm: 'alarms',
  wake: 'wakes',
  profile: 'profiles',
};

const wakeItem = (id: string, scheduledAt: string, snoozeCount: number) => ({
  id,
  userId: 'user-1',
  environment: 'SANDBOX',
  userEnvironment: 'user-1:SANDBOX',
  alarmId: 'alarm-1',
  alarmOccurrenceId: `occurrence-${id}`,
  scheduledAt,
  completedAt: '2026-08-12T06:30:00.000Z',
  snoozeCount,
  createdAt: '2026-08-12T06:30:00.000Z',
});

describe('Dynamo sync statistics', () => {
  it('restores today\'s no-snooze morning using the user\'s local scheduled date', async () => {
    const send = vi
      .fn()
      .mockResolvedValueOnce({ Item: { timezone: 'Europe/Zurich' } })
      .mockResolvedValueOnce({
        Items: [
          wakeItem('previous-day', '2026-08-11T21:30:00.000Z', 0),
          wakeItem('today-snoozed', '2026-08-12T05:00:00.000Z', 2),
          // 22:30 UTC is already the next local day during CEST.
          wakeItem('today-no-snooze', '2026-08-11T22:30:00.000Z', 0),
        ],
      });
    const repository = new DynamoSyncRepository(tables, 'SANDBOX', {
      send,
    } as unknown as DynamoDBDocumentClient);

    const statistics = await repository.statistics('user-1', '2026-08-12T10:00:00.000Z');

    expect(statistics.todayNoSnoozeMorning).toBe(true);
  });
});
