import type { AppSyncIdentityCognito } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  handleAccountApiEvent,
  type AccountApiEvent,
  type AccountApiRepository,
} from '../amplify/functions/account-api/handler.js';

const userId = 'cognito-user-1';
const now = '2026-07-31T16:30:00.000Z';

function identity(): AppSyncIdentityCognito {
  return {
    sub: userId,
    issuer: 'https://cognito-idp.eu-central-1.amazonaws.com/test-pool',
    username: userId,
    claims: { sub: userId },
    sourceIp: ['127.0.0.1'],
    defaultAuthStrategy: 'ALLOW',
    groups: null,
  };
}

function event(fieldName: string, arguments_: AccountApiEvent['arguments'] = {}): AccountApiEvent {
  return {
    typeName: 'Query',
    fieldName,
    arguments: arguments_,
    identity: identity(),
    source: null,
    request: {},
    prev: null,
  };
}

function repository(): AccountApiRepository {
  return {
    getPointAccountView: vi.fn().mockResolvedValue({
      officialBalance: 2_000,
      activePointPeriodId: 'period-1',
      initialAllocation: 2_000,
      pointsDeducted: 0,
      periodStart: '2026-07-31T16:18:47.000Z',
      periodEnd: '2026-08-31T16:18:47.000Z',
      subscriptionStatus: 'ACTIVE',
      donationMicroUsd: 2_000_000,
      serverTimestamp: now,
    }),
    listPointTransactions: vi.fn().mockResolvedValue({
      items: [],
      nextToken: undefined,
    }),
  };
}

describe('account API Amplify function event dispatch', () => {
  it('loads the point account using the top-level fieldName and Cognito sub', async () => {
    const accountRepository = repository();

    const result = await handleAccountApiEvent(event('getMyPointAccount'), accountRepository, now);

    expect(accountRepository.getPointAccountView).toHaveBeenCalledWith(userId, now);
    expect(result).toMatchObject({
      officialBalance: 2_000,
      donationMicroUsd: '2000000',
    });
  });

  it('lists transactions using the top-level fieldName and validated arguments', async () => {
    const accountRepository = repository();

    await handleAccountApiEvent(
      event('listMyPointTransactions', { limit: 30, nextToken: 'next-page' }),
      accountRepository,
      now,
    );

    expect(accountRepository.listPointTransactions).toHaveBeenCalledWith(userId, 30, 'next-page');
  });

  it('treats nullable GraphQL pagination arguments as omitted', async () => {
    const accountRepository = repository();

    await handleAccountApiEvent(
      event('listMyPointTransactions', { limit: null, nextToken: null }),
      accountRepository,
      now,
    );

    expect(accountRepository.listPointTransactions).toHaveBeenCalledWith(userId, 50, undefined);
  });

  it('does not require an info property and rejects unsupported fields', async () => {
    const accountRepository = repository();
    const deployedEnvelope = event('unsupportedOperation');

    expect('info' in deployedEnvelope).toBe(false);
    await expect(handleAccountApiEvent(deployedEnvelope, accountRepository, now)).rejects.toThrow(
      'UNSUPPORTED_OPERATION',
    );
  });

  it('rejects requests without a Cognito identity', async () => {
    const accountRepository = repository();

    await expect(
      handleAccountApiEvent(
        { ...event('getMyPointAccount'), identity: null },
        accountRepository,
        now,
      ),
    ).rejects.toThrow('AUTHENTICATION_REQUIRED');
  });
});
