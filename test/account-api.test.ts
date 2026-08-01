import type { AppSyncIdentityCognito } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  handleAccountApiEvent,
  type AccountApiEvent,
  type AccountApiRepository,
} from '../amplify/functions/account-api/handler.js';
import type { RecordWakeCommand, SaveSyncedAlarmCommand } from '../amplify/shared/sync-types.js';

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
      isEligible: true,
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
    listAlarms: vi.fn().mockResolvedValue([]),
    saveAlarm: vi.fn().mockImplementation(async (command: SaveSyncedAlarmCommand) => ({
      id: command.alarmId,
      userId: command.userId,
      environment: 'SANDBOX',
      userEnvironment: `${command.userId}:SANDBOX`,
      hour: command.hour,
      minute: command.minute,
      repeatWeekdays: command.repeatWeekdays,
      snoozeDurationMinutes: command.snoozeDurationMinutes,
      label: command.label,
      isEnabled: command.isEnabled,
      timezone: command.timezone,
      version: command.expectedVersion + 1,
      createdAt: now,
      updatedAt: now,
    })),
    archiveAlarm: vi.fn(),
    recordWake: vi.fn().mockImplementation(async (command: RecordWakeCommand) => ({
      duplicate: false,
      event: {
        id: command.wakeEventId,
        userId: command.userId,
        environment: 'SANDBOX',
        userEnvironment: `${command.userId}:SANDBOX`,
        alarmId: command.alarmId,
        alarmOccurrenceId: command.alarmOccurrenceId,
        scheduledAt: command.scheduledAt,
        completedAt: command.completedAt,
        snoozeCount: 0,
        createdAt: now,
      },
    })),
    statistics: vi.fn().mockResolvedValue({
      weekSnoozes: 0,
      weekWakeUps: 0,
      weekNoSnoozeMornings: 0,
      allTimeSnoozes: 0,
      allTimeWakeUps: 0,
      allTimeNoSnoozeMornings: 0,
      currentBalance: 2_000,
      currentPeriodDeducted: 0,
      lifetimeDeducted: 0,
      timezone: 'Europe/Zurich',
      serverTimestamp: now,
    }),
    dashboard: vi.fn().mockResolvedValue({
      status: 'NOT_PUBLISHED',
      charities: [],
      totalVotes: 0,
      canVoteToday: false,
      serverTimestamp: now,
    }),
    castVote: vi.fn().mockResolvedValue({
      accepted: true,
      duplicate: false,
      charityId: 'charity-1',
      localVoteDate: '2026-07-31',
      totalVotes: 1,
      serverTimestamp: now,
    }),
    recordEngagement: vi.fn().mockResolvedValue({
      accepted: true,
      duplicate: false,
      serverTimestamp: now,
    }),
  };
}

describe('account API Amplify function event dispatch', () => {
  it('loads the point account using the top-level fieldName and Cognito sub', async () => {
    const accountRepository = repository();

    const result = await handleAccountApiEvent(event('getMyPointAccount'), accountRepository, now);

    expect(accountRepository.getPointAccountView).toHaveBeenCalledWith(userId, now);
    expect(result).toMatchObject({
      isEligible: true,
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

  it('injects the Cognito sub when syncing an alarm', async () => {
    const accountRepository = repository();
    await handleAccountApiEvent(
      event('saveMySyncedAlarm', {
        input: {
          alarmId: '0e50d147-9a75-4e26-aa50-0ac6b6cd49ec',
          expectedVersion: 0,
          hour: 7,
          minute: 15,
          repeatWeekdays: [1, 2, 3, 4, 5],
          snoozeDurationMinutes: 9,
          label: 'Morning',
          isEnabled: true,
          timezone: 'Europe/Zurich',
        },
      }),
      accountRepository,
      now,
    );

    expect(accountRepository.saveAlarm).toHaveBeenCalledWith(
      expect.objectContaining({ userId, hour: 7, minute: 15 }),
      now,
    );
  });

  it('records a wake event without accepting a client snooze count', async () => {
    const accountRepository = repository();
    const result = await handleAccountApiEvent(
      event('recordWakeCompletion', {
        input: {
          wakeEventId: 'be106a48-f2b2-46b9-b370-95891370e36c',
          alarmId: 'alarm-1',
          alarmOccurrenceId: 'occurrence-1',
          scheduledAt: '2026-07-31T05:00:00.000Z',
          completedAt: '2026-07-31T05:05:00.000Z',
        },
      }),
      accountRepository,
      now,
    );

    expect(accountRepository.recordWake).toHaveBeenCalledWith(
      expect.objectContaining({ userId, alarmOccurrenceId: 'occurrence-1' }),
      now,
    );
    expect(result).toMatchObject({ accepted: true, duplicate: false, snoozeCount: 0 });
  });

  it('checks backend eligibility before accepting a daily charity vote', async () => {
    const accountRepository = repository();
    const result = await handleAccountApiEvent(
      event('castMyDailyCharityVote', { charityId: 'charity-1' }),
      accountRepository,
      now,
    );

    expect(accountRepository.getPointAccountView).toHaveBeenCalledWith(userId, now);
    expect(accountRepository.castVote).toHaveBeenCalledWith(userId, 'charity-1', now);
    expect(result).toMatchObject({ accepted: true, charityId: 'charity-1' });
  });

  it('records allow-listed engagement using the Cognito sub', async () => {
    const accountRepository = repository();
    const result = await handleAccountApiEvent(
      event('recordMyEngagement', {
        input: {
          eventId: '9171508a-a5a4-45d7-9f51-f2c53e64156a',
          sessionId: 'ce11e856-4540-466d-b539-8235cd39d659',
          name: 'TODAY_VIEWED',
          occurredAt: '2026-07-31T16:29:00.000Z',
          appVersion: '1.0 (1)',
        },
      }),
      accountRepository,
      now,
    );

    expect(accountRepository.recordEngagement).toHaveBeenCalledWith(
      expect.objectContaining({ userId, name: 'TODAY_VIEWED' }),
      now,
    );
    expect(result).toMatchObject({ accepted: true, duplicate: false });
  });

  it('rejects stale engagement timestamps', async () => {
    const accountRepository = repository();

    await expect(
      handleAccountApiEvent(
        event('recordMyEngagement', {
          input: {
            eventId: '9171508a-a5a4-45d7-9f51-f2c53e64156a',
            sessionId: 'ce11e856-4540-466d-b539-8235cd39d659',
            name: 'TODAY_VIEWED',
            occurredAt: '2026-07-01T16:29:00.000Z',
          },
        }),
        accountRepository,
        now,
      ),
    ).rejects.toThrow('INVALID_ENGAGEMENT_TIME');
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
