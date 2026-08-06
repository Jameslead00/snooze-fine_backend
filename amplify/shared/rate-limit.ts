import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { DomainError } from './domain.js';
import { sha256 } from './security.js';

export type RateLimitPolicy = {
  name: string;
  limit: number;
  windowSeconds: number;
};

export interface RateLimiter {
  check(subject: string, policy: RateLimitPolicy): Promise<void>;
}

export class NoopRateLimiter implements RateLimiter {
  public async check(_subject: string, _policy: RateLimitPolicy): Promise<void> {}
}

export const RATE_LIMIT_POLICIES: Readonly<Record<string, RateLimitPolicy>> = Object.freeze({
  getMyEarnedPointAccount: { name: 'account-read', limit: 120, windowSeconds: 300 },
  listMyPointAwards: { name: 'point-awards-read', limit: 120, windowSeconds: 300 },
  listMySyncedAlarms: { name: 'alarm-list', limit: 120, windowSeconds: 300 },
  saveMySyncedAlarm: { name: 'alarm-save', limit: 30, windowSeconds: 300 },
  archiveMySyncedAlarm: { name: 'alarm-archive', limit: 30, windowSeconds: 300 },
  recordWakeCompletion: { name: 'wake-completion', limit: 20, windowSeconds: 300 },
  getMyAccountabilityStatistics: { name: 'accountability-read', limit: 120, windowSeconds: 300 },
  getMyWeeklyProgressRecap: { name: 'weekly-recap-read', limit: 60, windowSeconds: 300 },
  getMySocialProfile: { name: 'social-profile-read', limit: 120, windowSeconds: 300 },
  setMyUsername: { name: 'username-set', limit: 5, windowSeconds: 3_600 },
  sendFriendRequest: { name: 'friend-request-send', limit: 10, windowSeconds: 600 },
  listMyFriendRequests: { name: 'friend-request-list', limit: 120, windowSeconds: 300 },
  acceptFriendRequest: { name: 'friend-request-accept', limit: 30, windowSeconds: 300 },
  declineFriendRequest: { name: 'friend-request-decline', limit: 30, windowSeconds: 300 },
  cancelFriendRequest: { name: 'friend-request-cancel', limit: 30, windowSeconds: 300 },
  listMyFriends: { name: 'friends-list', limit: 120, windowSeconds: 300 },
  removeMyFriend: { name: 'friend-remove', limit: 30, windowSeconds: 300 },
  getMyFriendsLeaderboard: { name: 'friends-leaderboard-read', limit: 60, windowSeconds: 300 },
  recordMyEngagement: { name: 'engagement-record', limit: 60, windowSeconds: 300 },
  getMyHabits: { name: 'habit-read', limit: 120, windowSeconds: 300 },
  saveMyHabit: { name: 'habit-save', limit: 30, windowSeconds: 300 },
  archiveMyHabit: { name: 'habit-archive', limit: 30, windowSeconds: 300 },
  reportHabitProgress: { name: 'habit-progress', limit: 60, windowSeconds: 300 },
  linkRevenueCatCustomer: { name: 'revenuecat-link', limit: 5, windowSeconds: 3_600 },
  requestMyAccountDeletion: { name: 'account-deletion', limit: 3, windowSeconds: 3_600 },
});

export function rateLimitPolicyFor(fieldName: string): RateLimitPolicy | undefined {
  return RATE_LIMIT_POLICIES[fieldName];
}

type RateLimitClient = Pick<DynamoDBDocumentClient, 'send'>;

export class DynamoRateLimiter implements RateLimiter {
  private readonly client: RateLimitClient;
  private readonly tableName: string;
  private readonly now: () => number;

  public constructor(
    client: RateLimitClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
      marshallOptions: { removeUndefinedValues: true },
    }),
    now: () => number = Date.now,
  ) {
    const tableName = process.env.RATE_LIMIT_TABLE_NAME;
    if (tableName === undefined || tableName.length === 0) {
      throw new Error('RATE_LIMIT_TABLE_NAME is not configured');
    }
    this.client = client;
    this.tableName = tableName;
    this.now = now;
  }

  public async check(subject: string, policy: RateLimitPolicy): Promise<void> {
    const nowSeconds = Math.floor(this.now() / 1_000);
    const windowStart = Math.floor(nowSeconds / policy.windowSeconds) * policy.windowSeconds;
    const bucketKey = `v1:${sha256(`${policy.name}:${subject}:${windowStart}`)}`;

    let count: number;
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { bucketKey },
          UpdateExpression:
            'SET #requestCount = if_not_exists(#requestCount, :zero) + :one, #expiresAt = if_not_exists(#expiresAt, :expiresAt)',
          ExpressionAttributeNames: {
            '#requestCount': 'requestCount',
            '#expiresAt': 'expiresAt',
          },
          ExpressionAttributeValues: {
            ':zero': 0,
            ':one': 1,
            ':expiresAt': windowStart + policy.windowSeconds + 3_600,
          },
          ReturnValues: 'UPDATED_NEW',
        }),
      );
      count = Number(result.Attributes?.requestCount);
    } catch {
      // Fail closed: an unavailable limiter must not silently disable abuse controls.
      throw new DomainError('RATE_LIMIT_UNAVAILABLE');
    }

    if (!Number.isSafeInteger(count) || count > policy.limit) {
      throw new DomainError('RATE_LIMITED');
    }
  }
}
