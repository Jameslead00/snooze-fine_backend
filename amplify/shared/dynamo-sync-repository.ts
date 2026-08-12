import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RevenueCatEnvironment } from './config.js';
import { DomainError } from './domain.js';
import { localDeadlineUtc, localParts } from './habits.js';
import type { SyncRepository } from './sync-repository.js';
import type {
  AccountabilityStatistics,
  RecordWakeCommand,
  SaveSyncedAlarmCommand,
  SyncedAlarm,
  WakeCompletion,
} from './sync-types.js';

export interface SyncTableNames {
  alarm: string;
  wake: string;
  profile: string;
}

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function syncTableNamesFromEnvironment(): SyncTableNames {
  return {
    alarm: requiredEnvironmentVariable('SYNCED_ALARM_TABLE_NAME'),
    wake: requiredEnvironmentVariable('WAKE_COMPLETION_TABLE_NAME'),
    profile: requiredEnvironmentVariable('USER_PROFILE_TABLE_NAME'),
  };
}

const userEnvironment = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${environment}`;

const asAlarm = (item: Record<string, unknown>): SyncedAlarm => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  userEnvironment: String(item.userEnvironment),
  hour: Number(item.hour),
  minute: Number(item.minute),
  repeatWeekdays: Array.isArray(item.repeatWeekdays) ? item.repeatWeekdays.map(Number) : [],
  snoozeDurationMinutes: Number(item.snoozeDurationMinutes),
  label: String(item.label),
  isEnabled: Boolean(item.isEnabled),
  timezone: String(item.timezone),
  version: Number(item.version),
  createdAt: String(item.createdAt),
  updatedAt: String(item.updatedAt),
});

const asWake = (item: Record<string, unknown>): WakeCompletion => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  userEnvironment: String(item.userEnvironment),
  alarmId: String(item.alarmId),
  alarmOccurrenceId: String(item.alarmOccurrenceId),
  scheduledAt: String(item.scheduledAt),
  completedAt: String(item.completedAt),
  snoozeCount: Math.min(100, Math.max(0, Number(item.snoozeCount ?? 0) || 0)),
  createdAt: String(item.createdAt),
});

export class DynamoSyncRepository implements SyncRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: SyncTableNames,
    private readonly environment: RevenueCatEnvironment,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async listAlarms(userId: string): Promise<SyncedAlarm[]> {
    const result = await this.client.send(
      new QueryCommand({
        TableName: this.tables.alarm,
        IndexName: 'byUserEnvironmentAndUpdatedAt',
        KeyConditionExpression: 'userEnvironment = :userEnvironment',
        ExpressionAttributeValues: {
          ':userEnvironment': userEnvironment(userId, this.environment),
        },
        ScanIndexForward: false,
      }),
    );
    return (result.Items ?? []).map(asAlarm);
  }

  public async saveAlarm(command: SaveSyncedAlarmCommand, now: string): Promise<SyncedAlarm> {
    const prior = await this.item(this.tables.alarm, command.alarmId);
    if (prior !== undefined && String(prior.userId) !== command.userId) {
      throw new DomainError('ALARM_ID_ALREADY_USED');
    }
    const current = prior === undefined ? undefined : asAlarm(prior);
    if ((current?.version ?? 0) !== command.expectedVersion) {
      throw new DomainError('ALARM_VERSION_CONFLICT');
    }
    const alarm: SyncedAlarm = {
      id: command.alarmId,
      userId: command.userId,
      environment: this.environment,
      userEnvironment: userEnvironment(command.userId, this.environment),
      hour: command.hour,
      minute: command.minute,
      repeatWeekdays: [...new Set(command.repeatWeekdays)].sort((a, b) => a - b),
      snoozeDurationMinutes: command.snoozeDurationMinutes,
      label: command.label,
      isEnabled: command.isEnabled,
      timezone: command.timezone,
      version: command.expectedVersion + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tables.alarm,
        Item: alarm,
        ConditionExpression:
          current === undefined ? 'attribute_not_exists(id)' : '#version = :version',
        ExpressionAttributeNames: current === undefined ? undefined : { '#version': 'version' },
        ExpressionAttributeValues:
          current === undefined ? undefined : { ':version': current.version },
      }),
    );
    return alarm;
  }

  public async archiveAlarm(
    userId: string,
    alarmId: string,
    expectedVersion: number,
    now: string,
  ): Promise<SyncedAlarm> {
    const prior = await this.item(this.tables.alarm, alarmId);
    if (prior === undefined || String(prior.userId) !== userId)
      throw new DomainError('ALARM_NOT_FOUND');
    const current = asAlarm(prior);
    if (current.version !== expectedVersion) throw new DomainError('ALARM_VERSION_CONFLICT');
    return this.saveAlarm(
      {
        userId,
        alarmId,
        expectedVersion,
        hour: current.hour,
        minute: current.minute,
        repeatWeekdays: current.repeatWeekdays,
        snoozeDurationMinutes: current.snoozeDurationMinutes,
        label: current.label,
        isEnabled: false,
        timezone: current.timezone,
      },
      now,
    );
  }

  public async recordWake(
    command: RecordWakeCommand,
    now: string,
  ): Promise<{ event: WakeCompletion; duplicate: boolean }> {
    const prior = await this.item(this.tables.wake, command.wakeEventId);
    if (prior !== undefined) {
      const event = asWake(prior);
      if (event.userId !== command.userId) throw new DomainError('WAKE_EVENT_ID_ALREADY_USED');
      return { event, duplicate: true };
    }
    const event: WakeCompletion = {
      id: command.wakeEventId,
      userId: command.userId,
      environment: this.environment,
      userEnvironment: userEnvironment(command.userId, this.environment),
      alarmId: command.alarmId,
      alarmOccurrenceId: command.alarmOccurrenceId,
      scheduledAt: command.scheduledAt,
      completedAt: command.completedAt,
      snoozeCount: command.snoozeCount,
      createdAt: now,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.wake,
          Item: event,
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
      return { event, duplicate: false };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException')
        throw error;
      return this.recordWake(command, now);
    }
  }

  public async statistics(userId: string, now: string): Promise<AccountabilityStatistics> {
    const profile = await this.item(this.tables.profile, userId);
    const timezone = typeof profile?.timezone === 'string' ? profile.timezone : 'UTC';
    const local = localParts(now, timezone);
    const localMidnight = new Date(`${local.date}T00:00:00.000Z`);
    localMidnight.setUTCDate(localMidnight.getUTCDate() - (local.weekday - 1));
    const weekStart = localDeadlineUtc(localMidnight.toISOString().slice(0, 10), 0, timezone);
    const wakes = (
      await this.queryAll(
        this.tables.wake,
        'byUserEnvironmentAndCompletedAt',
        'userEnvironment',
        userEnvironment(userId, this.environment),
      )
    ).map(asWake);
    const todayNoSnoozeMorning = wakes.some(
      (wake) =>
        wake.snoozeCount === 0 && localParts(wake.scheduledAt, timezone).date === local.date,
    );
    const weekWakes = wakes.filter((wake) => wake.completedAt >= weekStart);
    const successfulWeekWakes = weekWakes.filter((wake) => wake.snoozeCount === 0);
    const successfulWakes = wakes.filter((wake) => wake.snoozeCount === 0);
    return {
      todayNoSnoozeMorning,
      weekSnoozes: weekWakes.reduce((total, wake) => total + wake.snoozeCount, 0),
      weekWakeUps: successfulWeekWakes.length,
      weekNoSnoozeMornings: successfulWeekWakes.length,
      allTimeSnoozes: wakes.reduce((total, wake) => total + wake.snoozeCount, 0),
      allTimeWakeUps: successfulWakes.length,
      allTimeNoSnoozeMornings: successfulWakes.length,
      timezone,
      serverTimestamp: now,
    };
  }

  private async item(tableName: string, id: string): Promise<Record<string, unknown> | undefined> {
    return (await this.client.send(new GetCommand({ TableName: tableName, Key: { id } }))).Item;
  }

  private async queryAll(
    tableName: string,
    indexName: string,
    keyName: string,
    keyValue: string,
  ): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression: '#key = :value',
          ExpressionAttributeNames: { '#key': keyName },
          ExpressionAttributeValues: { ':value': keyValue },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }
}
