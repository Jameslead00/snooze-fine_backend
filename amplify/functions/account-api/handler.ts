import type { AppSyncIdentity } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import type { CommunityRepository } from '../../shared/community-repository.js';
import { configuredEnvironment } from '../../shared/config.js';
import {
  communityTableNamesFromEnvironment,
  DynamoCommunityRepository,
} from '../../shared/dynamo-community-repository.js';
import {
  DynamoEngagementRepository,
  engagementTableNameFromEnvironment,
} from '../../shared/dynamo-engagement-repository.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
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
import type { PlatformRepository } from '../../shared/repository.js';
import type { SyncRepository } from '../../shared/sync-repository.js';
import {
  archiveSyncedAlarmArgumentsSchema,
  charityVoteArgumentsSchema,
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

export type AccountApiRepository = Pick<
  PlatformRepository,
  'getPointAccountView' | 'getCommunityDonationProjection' | 'listPointTransactions'
> &
  SyncRepository &
  CommunityRepository &
  EngagementRepository & {
    weeklyProgressRecap: (userId: string, now: string) => Promise<WeeklyProgressRecap>;
  };

export async function handleAccountApiEvent(
  event: AccountApiEvent,
  repository: AccountApiRepository,
  now = new Date().toISOString(),
): Promise<unknown> {
  const userId = cognitoSub(event.identity);
  if (event.fieldName === 'getMyPointAccount') {
    const view = await repository.getPointAccountView(userId, now);
    return { ...view, donationMicroUsd: String(view.donationMicroUsd) };
  }
  if (event.fieldName === 'listMyPointTransactions') {
    const arguments_ = listTransactionsArgumentsSchema.parse(event.arguments);
    const page = await repository.listPointTransactions(
      userId,
      arguments_.limit ?? 50,
      arguments_.nextToken,
    );
    return {
      items: page.items.map((transaction) => ({
        id: transaction.id,
        pointPeriodId: transaction.pointPeriodId,
        amount: transaction.amount,
        transactionType: transaction.transactionType,
        reasonCode: transaction.reasonCode,
        source: transaction.source,
        sourceEventId: transaction.sourceEventId,
        relatedEventId: transaction.relatedEventId,
        balanceAfter: transaction.balanceAfter,
        createdAt: transaction.createdAt,
      })),
      nextToken: page.nextToken,
    };
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
    return {
      accepted: true,
      duplicate: result.duplicate,
      snoozeCount: result.event.snoozeCount,
      serverTimestamp: now,
    };
  }
  if (event.fieldName === 'getMyAccountabilityStatistics') {
    return repository.statistics(userId, now);
  }
  if (event.fieldName === 'getMyWeeklyProgressRecap') {
    return repository.weeklyProgressRecap(userId, now);
  }
  if (event.fieldName === 'getCommunityDashboard') {
    const [dashboard, account, projection] = await Promise.all([
      repository.dashboard(userId, now),
      repository.getPointAccountView(userId, now),
      repository.getCommunityDonationProjection(now),
    ]);
    return {
      ...dashboard,
      canVoteToday: dashboard.canVoteToday && account.isEligible,
      projectedDonationMicroUsd: String(projection.expectedDonationMicroUsd),
    };
  }
  if (event.fieldName === 'castMyDailyCharityVote') {
    const input = charityVoteArgumentsSchema.parse(event.arguments);
    const account = await repository.getPointAccountView(userId, now);
    if (!account.isEligible) throw new DomainError('SUBSCRIPTION_NOT_ELIGIBLE');
    return repository.castVote(userId, input.charityId, now);
  }
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
  const platform = new DynamoPlatformRepository(
    tableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const sync = new DynamoSyncRepository(syncTableNamesFromEnvironment(), configuredEnvironment());
  const habits = new DynamoHabitRepository(
    habitTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const community = new DynamoCommunityRepository(
    communityTableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const engagement = new DynamoEngagementRepository(
    engagementTableNameFromEnvironment(),
    configuredEnvironment(),
  );
  const repository: AccountApiRepository = {
    getPointAccountView: (userId, now) => platform.getPointAccountView(userId, now),
    getCommunityDonationProjection: (now) => platform.getCommunityDonationProjection(now),
    listPointTransactions: (userId, limit, nextToken) =>
      platform.listPointTransactions(userId, limit, nextToken),
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
    dashboard: (userId, now) => community.dashboard(userId, now),
    castVote: (userId, charityId, now) => community.castVote(userId, charityId, now),
    recordEngagement: (command, now) => engagement.recordEngagement(command, now),
  };
  return handleAccountApiEvent(event, repository);
};
