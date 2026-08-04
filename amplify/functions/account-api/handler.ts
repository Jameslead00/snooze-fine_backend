import type { AppSyncIdentity } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import {
  awardConfigurationFromEnvironment,
  allowTestFlightSandboxSubscriptions,
  configuredEnvironment,
  type AwardConfiguration,
} from '../../shared/config.js';
import {
  DynamoSocialRepository,
  normalizeUsername,
  socialTableNamesFromEnvironment,
} from '../../shared/dynamo-social-repository.js';
import {
  DynamoEngagementRepository,
  engagementTableNameFromEnvironment,
} from '../../shared/dynamo-engagement-repository.js';
import {
  DynamoEarnedPointsRepository,
  earnedPointsTableNamesFromEnvironment,
} from '../../shared/dynamo-earned-points-repository.js';
import type { EarnedPointsRepository } from '../../shared/earned-points-repository.js';
import { DomainError } from '../../shared/domain.js';
import {
  DynamoHabitRepository,
  habitTableNamesFromEnvironment,
} from '../../shared/dynamo-habit-repository.js';
import type { EngagementRepository } from '../../shared/engagement-repository.js';
import { weeklyProgressRecap, type WeeklyProgressRecap } from '../../shared/recaps.js';
import {
  DynamoSyncRepository,
  syncTableNamesFromEnvironment,
} from '../../shared/dynamo-sync-repository.js';
import type { SyncRepository } from '../../shared/sync-repository.js';
import type { SocialRepository } from '../../shared/social-repository.js';
import type { SubscriptionRepository } from '../../shared/subscription-repository.js';
import {
  DynamoSubscriptionRepository,
  subscriptionTableNameFromEnvironment,
} from '../../shared/dynamo-subscription-repository.js';
import {
  archiveSyncedAlarmArgumentsSchema,
  listTransactionsArgumentsSchema,
  recordEngagementArgumentsSchema,
  recordWakeCompletionArgumentsSchema,
  saveSyncedAlarmArgumentsSchema,
} from '../../shared/validation.js';

export type AccountApiArguments = Record<string, unknown> & {
  limit?: unknown;
  nextToken?: unknown;
  input?: unknown;
};

export type AccountApiEvent = {
  typeName?: string;
  fieldName: string;
  arguments: AccountApiArguments;
  identity: AppSyncIdentity | null;
  source?: unknown;
  request?: unknown;
  prev?: unknown;
};

export type AccountApiRepository = EarnedPointsRepository &
  SyncRepository &
  SocialRepository &
  EngagementRepository & {
    getSubscriptionState: SubscriptionRepository['getSubscriptionState'];
    weeklyProgressRecap: (userId: string, now: string) => Promise<WeeklyProgressRecap>;
  };

const entitlementStatuses = new Set(['ACTIVE', 'GRACE_PERIOD', 'BILLING_ISSUE', 'CANCELLED_PENDING_EXPIRY']);

function hasCurrentEntitlement(
  subscription: Awaited<ReturnType<SubscriptionRepository['getSubscriptionState']>>,
  now: string,
): boolean {
  if (subscription === undefined || !entitlementStatuses.has(subscription.status)) return false;
  return Date.parse(subscription.currentPeriodEnd) > Date.parse(now);
}

async function currentEntitlement(
  repository: AccountApiRepository,
  userId: string,
  now: string,
): Promise<{ eligible: boolean; status: string }> {
  const configured = configuredEnvironment();
  const primary = await repository.getSubscriptionState(userId, configured);
  if (hasCurrentEntitlement(primary, now)) {
    return { eligible: true, status: primary?.status ?? 'UNKNOWN' };
  }

  if (allowTestFlightSandboxSubscriptions() && configured === 'PRODUCTION') {
    const sandbox = await repository.getSubscriptionState(userId, 'SANDBOX');
    if (hasCurrentEntitlement(sandbox, now)) {
      return { eligible: true, status: sandbox?.status ?? 'UNKNOWN' };
    }
  }

  return { eligible: false, status: primary?.status ?? 'INACTIVE' };
}

export async function handleAccountApiEvent(
  event: AccountApiEvent,
  repository: AccountApiRepository,
  now = new Date().toISOString(),
  awards: AwardConfiguration = awardConfigurationFromEnvironment(),
): Promise<unknown> {
  const userId = cognitoSub(event.identity);
  if (event.fieldName === 'getMyEarnedPointAccount') {
    const [account, entitlement] = await Promise.all([
      repository.getDisciPointAccount(userId, now),
      currentEntitlement(repository, userId, now),
    ]);
    return {
      isEligible: entitlement.eligible,
      earnedPointsTotal: account.currentPoints,
      subscriptionStatus: entitlement.status,
      serverTimestamp: now,
    };
  }
  if (event.fieldName === 'listMyPointAwards') {
    const arguments_ = listTransactionsArgumentsSchema.parse(event.arguments);
    return repository.listPointAwards(userId, arguments_.limit ?? 50, arguments_.nextToken);
  }
  if (event.fieldName === 'listMySyncedAlarms') {
    return repository.listAlarms(userId);
  }
  if (event.fieldName === 'saveMySyncedAlarm') {
    const input = saveSyncedAlarmArgumentsSchema.parse(event.arguments.input);
    return repository.saveAlarm({ userId, ...input }, now);
  }
  if (event.fieldName === 'archiveMySyncedAlarm') {
    const input = archiveSyncedAlarmArgumentsSchema.parse(event.arguments);
    const alarm = await repository.archiveAlarm(userId, input.alarmId, input.expectedVersion, now);
    return {
      id: alarm.id,
      version: alarm.version,
      archived: !alarm.isEnabled,
      serverTimestamp: now,
    };
  }
  if (event.fieldName === 'recordWakeCompletion') {
    const input = recordWakeCompletionArgumentsSchema.parse(event.arguments.input);
    const result = await repository.recordWake({ userId, ...input }, now);
    const earning = await repository.earnPoints(
      {
        userId,
        qualification: 'WAKE_COMPLETION',
        sourceEventId: result.event.id,
        points: awards.wakeCompletion,
      },
      now,
    );
    return {
      accepted: true,
      duplicate: result.duplicate,
      snoozeCount: result.event.snoozeCount,
      pointsAwarded: earning.pointsEarned,
      earnedPointsTotal: earning.currentPoints,
      serverTimestamp: now,
    };
  }
  if (event.fieldName === 'getMyAccountabilityStatistics') {
    const [statistics, account] = await Promise.all([
      repository.statistics(userId, now),
      repository.getDisciPointAccount(userId, now),
    ]);
    return {
      ...statistics,
      earnedPointsTotal: account.currentPoints,
    };
  }
  if (event.fieldName === 'getMyWeeklyProgressRecap') {
    return repository.weeklyProgressRecap(userId, now);
  }
  if (event.fieldName === 'getMySocialProfile') return repository.socialProfile(userId, now);
  if (event.fieldName === 'setMyUsername') {
    if (typeof event.arguments.username !== 'string') throw new DomainError('INVALID_USERNAME');
    const username = normalizeUsername(event.arguments.username);
    if (username === undefined) throw new DomainError('INVALID_USERNAME');
    return repository.setUsername(userId, username, now);
  }
  const socialOperation = new Set([
    'sendFriendRequest',
    'listMyFriendRequests',
    'acceptFriendRequest',
    'declineFriendRequest',
    'cancelFriendRequest',
    'listMyFriends',
    'removeMyFriend',
    'getMyFriendsLeaderboard',
  ]).has(event.fieldName);
  if (socialOperation && (await repository.socialProfile(userId, now)).usernameRequired) {
    throw new DomainError('USERNAME_REQUIRED');
  }
  if (event.fieldName === 'sendFriendRequest') {
    const username = typeof event.arguments.username === 'string' ? event.arguments.username : '';
    return repository.sendFriendRequest(userId, username, now);
  }
  if (event.fieldName === 'listMyFriendRequests') return repository.listFriendRequests(userId, now);
  if (event.fieldName === 'acceptFriendRequest') {
    if (typeof event.arguments.requestId !== 'string')
      throw new DomainError('FRIEND_REQUEST_NOT_FOUND');
    return repository.acceptFriendRequest(userId, event.arguments.requestId, now);
  }
  if (event.fieldName === 'declineFriendRequest') {
    if (typeof event.arguments.requestId !== 'string')
      throw new DomainError('FRIEND_REQUEST_NOT_FOUND');
    return repository.declineFriendRequest(userId, event.arguments.requestId, now);
  }
  if (event.fieldName === 'cancelFriendRequest') {
    if (typeof event.arguments.requestId !== 'string')
      throw new DomainError('FRIEND_REQUEST_NOT_FOUND');
    return repository.cancelFriendRequest(userId, event.arguments.requestId, now);
  }
  if (event.fieldName === 'listMyFriends') return { items: await repository.listFriends(userId) };
  if (event.fieldName === 'removeMyFriend') {
    if (typeof event.arguments.friendId !== 'string') throw new DomainError('FRIEND_NOT_FOUND');
    return repository.removeFriend(userId, event.arguments.friendId, now);
  }
  if (event.fieldName === 'getMyFriendsLeaderboard')
    return repository.friendsLeaderboard(userId, now);
  if (event.fieldName === 'recordMyEngagement') {
    const input = recordEngagementArgumentsSchema.parse(event.arguments.input);
    const occurredAt = Date.parse(input.occurredAt);
    const serverTime = Date.parse(now);
    if (
      occurredAt > serverTime + 5 * 60 * 1_000 ||
      occurredAt < serverTime - 7 * 24 * 60 * 60 * 1_000
    ) {
      throw new DomainError('INVALID_ENGAGEMENT_TIME');
    }
    return repository.recordEngagement({ userId, ...input }, now);
  }
  throw new DomainError('UNSUPPORTED_OPERATION');
}

export const handler = async (event: AccountApiEvent): Promise<unknown> => {
  const earnedPoints = new DynamoEarnedPointsRepository(
    earnedPointsTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const sync = new DynamoSyncRepository(syncTableNamesFromEnvironment(), configuredEnvironment());
  const habits = new DynamoHabitRepository(
    habitTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const social = new DynamoSocialRepository(
    socialTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const engagement = new DynamoEngagementRepository(
    engagementTableNameFromEnvironment(),
    configuredEnvironment(),
  );
  const subscriptions = new DynamoSubscriptionRepository(
    subscriptionTableNameFromEnvironment(),
  );
  const repository: AccountApiRepository = {
    getDisciPointAccount: (userId, now) => earnedPoints.getDisciPointAccount(userId, now),
    earnPoints: (command, now) => earnedPoints.earnPoints(command, now),
    listPointAwards: (userId, limit, nextToken) =>
      earnedPoints.listPointAwards(userId, limit, nextToken),
    listAlarms: (userId) => sync.listAlarms(userId),
    saveAlarm: (command, now) => sync.saveAlarm(command, now),
    archiveAlarm: (userId, alarmId, expectedVersion, now) =>
      sync.archiveAlarm(userId, alarmId, expectedVersion, now),
    recordWake: (command, now) => sync.recordWake(command, now),
    statistics: (userId, now) => sync.statistics(userId, now),
    weeklyProgressRecap: (userId, now) =>
      weeklyProgressRecap(
        {
          listHabits: (recapUserId) => habits.listHabits(recapUserId),
          listOccurrences: (recapUserId, localDate) =>
            habits.listOccurrences(recapUserId, localDate),
          statistics: (recapUserId, recapNow) => sync.statistics(recapUserId, recapNow),
        },
        userId,
        now,
      ),
    socialProfile: (userId, now) => social.socialProfile(userId, now),
    setUsername: (userId, username, now) => social.setUsername(userId, username, now),
    sendFriendRequest: (userId, username, now) => social.sendFriendRequest(userId, username, now),
    listFriendRequests: (userId, now) => social.listFriendRequests(userId, now),
    acceptFriendRequest: (userId, requestId, now) =>
      social.acceptFriendRequest(userId, requestId, now),
    declineFriendRequest: (userId, requestId, now) =>
      social.declineFriendRequest(userId, requestId, now),
    cancelFriendRequest: (userId, requestId, now) =>
      social.cancelFriendRequest(userId, requestId, now),
    listFriends: (userId) => social.listFriends(userId),
    removeFriend: (userId, friendId, now) => social.removeFriend(userId, friendId, now),
    friendsLeaderboard: (userId, now) => social.friendsLeaderboard(userId, now),
    recordEngagement: (command, now) => engagement.recordEngagement(command, now),
    getSubscriptionState: (userId, environment) =>
      subscriptions.getSubscriptionState(userId, environment),
  };
  return handleAccountApiEvent(
    event,
    repository,
    new Date().toISOString(),
    awardConfigurationFromEnvironment(),
  );
};
