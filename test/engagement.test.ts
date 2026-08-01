import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it, vi } from 'vitest';
import { DynamoEngagementRepository } from '../amplify/shared/dynamo-engagement-repository.js';

const command = {
  userId: 'cognito-user-1',
  eventId: '9171508a-a5a4-45d7-9f51-f2c53e64156a',
  sessionId: 'ce11e856-4540-466d-b539-8235cd39d659',
  name: 'SESSION_STARTED' as const,
  occurredAt: '2026-07-31T16:29:00.000Z',
  appVersion: '1.0 (1)',
};
const now = '2026-07-31T16:30:00.000Z';

describe('authenticated engagement events', () => {
  it('stores a first-party event without accepting a client user ID', async () => {
    const send = vi.fn().mockResolvedValueOnce({}).mockResolvedValueOnce({});
    const repository = new DynamoEngagementRepository('engagement-events', 'SANDBOX', {
      send,
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.recordEngagement(command, now)).resolves.toEqual({
      accepted: true,
      duplicate: false,
      serverTimestamp: now,
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('returns duplicate for the same account-bound event', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: {
        ...command,
        environment: 'SANDBOX',
        userEnvironment: `${command.userId}:SANDBOX`,
        platform: 'IOS',
        receivedAt: now,
      },
    });
    const repository = new DynamoEngagementRepository('engagement-events', 'SANDBOX', {
      send,
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.recordEngagement(command, now)).resolves.toMatchObject({
      accepted: true,
      duplicate: true,
    });
  });

  it('rejects reuse of an event ID across accounts', async () => {
    const send = vi.fn().mockResolvedValueOnce({
      Item: { ...command, userId: 'another-user', environment: 'SANDBOX' },
    });
    const repository = new DynamoEngagementRepository('engagement-events', 'SANDBOX', {
      send,
    } as unknown as DynamoDBDocumentClient);

    await expect(repository.recordEngagement(command, now)).rejects.toThrow(
      'ENGAGEMENT_EVENT_ID_ALREADY_USED',
    );
  });
});
