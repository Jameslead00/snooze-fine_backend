import type { AppSyncIdentityCognito } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  handleAccountApiEvent,
  type AccountApiEvent,
  type AccountApiRepository,
} from '../amplify/functions/account-api/handler.js';

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
});

const event = (fieldName: string, arguments_: Record<string, unknown> = {}): AccountApiEvent => ({
  fieldName,
  arguments: arguments_,
  identity,
  source: null,
  request: {},
  prev: null,
});

describe('earned-point account API', () => {
  it('returns only the earned-point account fields', async () => {
    const subject = repository();
    await expect(
      handleAccountApiEvent(event('getMyEarnedPointAccount'), subject, now),
    ).resolves.toEqual({
      isEligible: true,
      earnedPointsTotal: 25,
      subscriptionStatus: 'ACTIVE',
      serverTimestamp: now,
    });
  });

  it('lists immutable point awards', async () => {
    const subject = repository();
    await handleAccountApiEvent(event('listMyPointAwards', { limit: 30 }), subject, now);
    expect(subject.listPointAwards).toHaveBeenCalledWith(userId, 30, undefined);
  });
});
