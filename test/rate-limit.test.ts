import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  DynamoRateLimiter,
  RATE_LIMIT_POLICIES,
  rateLimitPolicyFor,
} from '../amplify/shared/rate-limit.js';

afterEach(() => {
  delete process.env.RATE_LIMIT_TABLE_NAME;
});

describe('per-user rate limiting', () => {
  it('defines limits for the abuse-sensitive operations', () => {
    expect(rateLimitPolicyFor('sendFriendRequest')).toEqual({
      name: 'friend-request-send',
      limit: 10,
      windowSeconds: 600,
    });
    expect(rateLimitPolicyFor('linkRevenueCatCustomer')).toEqual(
      { name: 'revenuecat-link', limit: 30, windowSeconds: 3_600 },
    );
    expect(rateLimitPolicyFor('unsupportedOperation')).toBeUndefined();
  });

  it('increments a hashed fixed-window bucket and permits requests at the limit', async () => {
    process.env.RATE_LIMIT_TABLE_NAME = 'rate-limit-test';
    let capturedCommand: unknown;
    const send = vi.fn(async (command: unknown) => {
      capturedCommand = command;
      return { Attributes: { requestCount: 10 } };
    });
    const client = { send } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
    const limiter = new DynamoRateLimiter(client, () => 1_700_000_000_000);

    await limiter.check('user-123', RATE_LIMIT_POLICIES.sendFriendRequest!);

    expect(send).toHaveBeenCalledOnce();
    const command = capturedCommand as { input?: Record<string, unknown> };
    expect(command?.input?.TableName).toBe('rate-limit-test');
    const bucketKey = (command?.input?.Key as { bucketKey?: unknown } | undefined)?.bucketKey;
    expect(bucketKey).toBeTypeOf('string');
    expect(bucketKey as string).toMatch(/^v1:[a-f0-9]{64}$/);
  });

  it('rejects requests over the configured limit', async () => {
    process.env.RATE_LIMIT_TABLE_NAME = 'rate-limit-test';
    const send = vi.fn(async (_command: unknown) => ({ Attributes: { requestCount: 11 } }));
    const client = { send } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
    const limiter = new DynamoRateLimiter(client, () => 1_700_000_000_000);

    await expect(
      limiter.check('user-123', RATE_LIMIT_POLICIES.sendFriendRequest!),
    ).rejects.toMatchObject({ code: 'RATE_LIMITED' });
  });

  it('fails closed when the counter cannot be written', async () => {
    process.env.RATE_LIMIT_TABLE_NAME = 'rate-limit-test';
    const send = vi.fn(async (_command: unknown) => {
      throw new Error('DynamoDB unavailable');
    });
    const client = { send } as unknown as Pick<DynamoDBDocumentClient, 'send'>;
    const limiter = new DynamoRateLimiter(client, () => 1_700_000_000_000);

    await expect(
      limiter.check('user-123', RATE_LIMIT_POLICIES.sendFriendRequest!),
    ).rejects.toMatchObject({ code: 'RATE_LIMIT_UNAVAILABLE' });
  });
});
