import type { AppSyncIdentityCognito } from 'aws-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  handleAccountApiEvent,
  type AccountApiEvent,
  type AccountApiRepository,
} from '../amplify/functions/account-api/handler.js';
import type { SubscriptionState } from '../amplify/shared/types.js';

const userId = 'cognito-user-1';
const now = '2026-07-31T16:30:00.000Z';
const identity: AppSyncIdentityCognito = {
  sub: userId,
  issuer: 'https://example.invalid',
  username: userId,
  claims: { sub: userId },
  sourceIp: ['127.0.0.1'],
  defaultAuthStrategy: 'ALLOW',
  groups: null,
};

const repository = (): AccountApiRepository => ({
  getDisciPointAccount: vi
    .fn()
    .mockResolvedValue({ currentPoints: 25, lifetimeEarned: 25, serverTimestamp: now }),
  earnPoints: vi.fn(),
  listPointAwards: vi.fn().mockResolvedValue({ items: [], nextToken: undefined }),
  listAlarms: vi.fn(),
  saveAlarm: vi.fn(),
  archiveAlarm: vi.fn(),
  recordWake: vi.fn(),
  statistics: vi.fn(),
  weeklyProgressRecap: vi.fn(),
  socialProfile: vi.fn().mockResolvedValue({ usernameRequired: false, username: 'tester' }),
  setUsername: vi.fn(),
  sendFriendRequest: vi.fn(),
  listFriendRequests: vi.fn(),
  acceptFriendRequest: vi.fn(),
  declineFriendRequest: vi.fn(),
  cancelFriendRequest: vi.fn(),
  listFriends: vi.fn(),
  removeFriend: vi.fn(),
  friendsLeaderboard: vi.fn(),
  recordEngagement: vi.fn(),
  getSubscriptionState: vi.fn().mockResolvedValue(undefined),
});

const event = (fieldName: string, arguments_: Record<string, unknown> = {}): AccountApiEvent => ({
  fieldName,
  arguments: arguments_,
  identity,
  source: null,
  request: {},
  prev: null,
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('earned-point account API', () => {
  it('does not unlock an account without a current subscription', async () => {
    const subject = repository();
    await expect(
      handleAccountApiEvent(event('getMyEarnedPointAccount'), subject, now),
    ).resolves.toEqual({
      isEligible: false,
      earnedPointsTotal: 25,
      subscriptionStatus: 'INACTIVE',
      serverTimestamp: now,
    });
  });

  it('unlocks an account with a current subscription', async () => {
    const subject = repository();
    const subscription: SubscriptionState = {
      id: `${userId}:snoozefine_plus:SANDBOX`,
      userId,
      revenueCatAppUserId: userId,
      entitlementId: 'snoozefine_plus',
      productId: 'snoozefine_plus_monthly',
      status: 'ACTIVE',
      environment: 'SANDBOX',
      originalPurchaseAt: '2026-07-01T00:00:00.000Z',
      currentPeriodStart: '2026-07-31T00:00:00.000Z',
      currentPeriodEnd: '2026-08-31T00:00:00.000Z',
      autoRenew: true,
      lastRevenueCatEventId: 'event-1',
      stateEventAt: now,
      statusEffectiveAt: now,
      updatedAt: now,
    };
    vi.mocked(subject.getSubscriptionState).mockResolvedValue(subscription);

    await expect(
      handleAccountApiEvent(event('getMyEarnedPointAccount'), subject, now),
    ).resolves.toMatchObject({
      isEligible: true,
      subscriptionStatus: 'ACTIVE',
    });
  });

  it('does not unlock an expired subscription', async () => {
    const subject = repository();
    vi.mocked(subject.getSubscriptionState).mockResolvedValue({
      id: `${userId}:snoozefine_plus:SANDBOX`,
      userId,
      revenueCatAppUserId: userId,
      entitlementId: 'snoozefine_plus',
      productId: 'snoozefine_plus_monthly',
      status: 'EXPIRED',
      environment: 'SANDBOX',
      originalPurchaseAt: '2026-07-01T00:00:00.000Z',
      currentPeriodStart: '2026-07-01T00:00:00.000Z',
      currentPeriodEnd: '2026-07-30T00:00:00.000Z',
      autoRenew: false,
      lastRevenueCatEventId: 'event-2',
      stateEventAt: now,
      statusEffectiveAt: '2026-07-30T00:00:00.000Z',
      updatedAt: now,
    });

    await expect(
      handleAccountApiEvent(event('getMyEarnedPointAccount'), subject, now),
    ).resolves.toMatchObject({
      isEligible: false,
      subscriptionStatus: 'EXPIRED',
    });
  });

  it('can use an isolated sandbox subscription for TestFlight in production', async () => {
    vi.stubEnv('SNOOZEFINE_ENVIRONMENT', 'PRODUCTION');
    vi.stubEnv('SNOOZEFINE_ALLOW_TESTFLIGHT_SANDBOX_SUBSCRIPTIONS', 'true');
    const subject = repository();
    const sandboxSubscription: SubscriptionState = {
      id: `${userId}:snoozefine_plus:SANDBOX`,
      userId,
      revenueCatAppUserId: userId,
      entitlementId: 'snoozefine_plus',
      productId: 'snoozefine_plus_monthly',
      status: 'ACTIVE',
      environment: 'SANDBOX',
      originalPurchaseAt: '2026-07-01T00:00:00.000Z',
      currentPeriodStart: '2026-07-31T00:00:00.000Z',
      currentPeriodEnd: '2026-08-31T00:00:00.000Z',
      autoRenew: true,
      lastRevenueCatEventId: 'event-testflight',
      stateEventAt: now,
      statusEffectiveAt: now,
      updatedAt: now,
    };
    vi.mocked(subject.getSubscriptionState).mockImplementation(async (_userId, environment) =>
      environment === 'SANDBOX' ? sandboxSubscription : undefined,
    );

    await expect(
      handleAccountApiEvent(event('getMyEarnedPointAccount'), subject, now),
    ).resolves.toMatchObject({
      isEligible: true,
      subscriptionStatus: 'ACTIVE',
    });
    expect(subject.getSubscriptionState).toHaveBeenCalledWith(userId, 'PRODUCTION');
    expect(subject.getSubscriptionState).toHaveBeenCalledWith(userId, 'SANDBOX');
  });

  it('lists immutable point awards', async () => {
    const subject = repository();
    await handleAccountApiEvent(event('listMyPointAwards', { limit: 30 }), subject, now);
    expect(subject.listPointAwards).toHaveBeenCalledWith(userId, 30, undefined);
  });

  it('awards wake points only for a recorded no-snooze morning', async () => {
    const subject = repository();
    vi.mocked(subject.recordWake).mockResolvedValue({
      duplicate: false,
      event: {
        id: 'wake-event-1',
        userId,
        environment: 'SANDBOX',
        userEnvironment: `${userId}:SANDBOX`,
        alarmId: 'alarm-1',
        alarmOccurrenceId: 'occurrence-1',
        scheduledAt: '2026-07-31T07:00:00.000Z',
        completedAt: now,
        snoozeCount: 0,
        createdAt: now,
      },
    });
    vi.mocked(subject.earnPoints).mockResolvedValue({
      duplicate: false,
      pointsEarned: 20,
      currentPoints: 45,
      lifetimeEarned: 45,
      serverTimestamp: now,
    });

    await expect(
      handleAccountApiEvent(
        event('recordWakeCompletion', {
          input: {
            wakeEventId: '11111111-1111-4111-8111-111111111111',
            alarmId: 'alarm-1',
            alarmOccurrenceId: 'occurrence-1',
            scheduledAt: '2026-07-31T07:00:00.000Z',
            completedAt: now,
            snoozeCount: 0,
          },
        }),
        subject,
        now,
      ),
    ).resolves.toMatchObject({ pointsAwarded: 20, earnedPointsTotal: 45 });
    expect(subject.earnPoints).toHaveBeenCalledOnce();
  });

  it('records a snoozed morning but awards no wake points', async () => {
    const subject = repository();
    vi.mocked(subject.recordWake).mockResolvedValue({
      duplicate: false,
      event: {
        id: 'wake-event-2',
        userId,
        environment: 'SANDBOX',
        userEnvironment: `${userId}:SANDBOX`,
        alarmId: 'alarm-1',
        alarmOccurrenceId: 'occurrence-2',
        scheduledAt: '2026-07-31T07:00:00.000Z',
        completedAt: now,
        snoozeCount: 2,
        createdAt: now,
      },
    });

    await expect(
      handleAccountApiEvent(
        event('recordWakeCompletion', {
          input: {
            wakeEventId: '22222222-2222-4222-8222-222222222222',
            alarmId: 'alarm-1',
            alarmOccurrenceId: 'occurrence-2',
            scheduledAt: '2026-07-31T07:00:00.000Z',
            completedAt: now,
            snoozeCount: 2,
          },
        }),
        subject,
        now,
      ),
    ).resolves.toMatchObject({
      snoozeCount: 2,
      pointsAwarded: 0,
      earnedPointsTotal: 25,
    });
    expect(subject.earnPoints).not.toHaveBeenCalled();
  });
});
