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
  DynamoEarnedPointsRepository,
  earnedPointsTableNamesFromEnvironment,
} from '../../shared/dynamo-earned-points-repository.js';
import type { EarnedPointsRepository } from '../../shared/earned-points-repository.js';
import { PLATFORM_CONFIG } from '../../shared/config.js';
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
  if (event.fieldName === 'getMyEarnedPointAccount') {
    const account = await repository.getDisciPointAccount(userId, now);
    return {
      isEligible: true,
      earnedPointsTotal: account.currentPoints,
      activeBallotId: undefined,
      activeBallotEarnedPoints: 0,
      activeBallotAllocatedVotes: 0,
      subscriptionStatus: 'ACTIVE',
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
        points: PLATFORM_CONFIG.wakeCompletionPointEarned,
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
      activeBallotEarnedPoints: 0,
    };
  }
  if (event.fieldName === 'getMyWeeklyProgressRecap') {
    return repository.weeklyProgressRecap(userId, now);
  }
  if (event.fieldName === 'getCommunityDashboard') {
    return repository.dashboard(userId, now);
  }
  if (event.fieldName === 'allocateMyCharityVotes') {
    const raw = event.arguments.input;
    if (typeof raw !== 'object' || raw === null) throw new DomainError('INVALID_VOTE_ALLOCATION');
    const input = raw as Record<string, unknown>;
    if (
      typeof input.charityId !== 'string' ||
      typeof input.ballotId !== 'string' ||
      typeof input.allocationEventId !== 'string' ||
      !Number.isInteger(input.allocatedVotes) ||
      Number(input.allocatedVotes) < 0
    ) {
      throw new DomainError('INVALID_VOTE_ALLOCATION');
    }
    return repository.allocatePoints(userId, input.charityId, now);
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
  const earnedPoints = new DynamoEarnedPointsRepository(
    earnedPointsTableNamesFromEnvironment(),
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
    dashboard: (userId, now) => community.dashboard(userId, now),
    allocatePoints: (userId, charityId, now) => community.allocatePoints(userId, charityId, now),
    recordEngagement: (command, now) => engagement.recordEngagement(command, now),
  };
  return handleAccountApiEvent(event, repository);
};
