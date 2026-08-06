import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  BatchWriteCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
  UpdateCommand,
  type BatchWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import type { ScheduledEvent } from 'aws-lambda';
import { log } from '../../shared/logger.js';

type DeletionStatus = 'REQUESTED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';
type DocumentWriteRequest = NonNullable<BatchWriteCommandInput['RequestItems']>[string][number];

export interface AccountDeletionRequestRecord {
  id: string;
  userId: string;
  status: DeletionStatus;
  attempts: number;
  requestedAt: string;
  updatedAt: string;
}

export interface AccountDeletionTableNames {
  request: string;
  profile: string;
  customerLink: string;
  webhook: string;
  subscription: string;
  earnedPointAccount: string;
  earnedPointEvent: string;
  syncedAlarm: string;
  wakeCompletion: string;
  engagementEvent: string;
  habit: string;
  habitOccurrence: string;
  habitProgressEvent: string;
  usernameReservation: string;
  friendRequest: string;
  friendConnection: string;
}

export interface AccountDeletionStore {
  listCandidates(now: string): Promise<AccountDeletionRequestRecord[]>;
  claim(request: AccountDeletionRequestRecord, now: string): Promise<boolean>;
  deleteUserData(userId: string): Promise<void>;
  complete(request: AccountDeletionRequestRecord): Promise<void>;
  fail(request: AccountDeletionRequestRecord, now: string, error: unknown): Promise<void>;
}

const environments = ['SANDBOX', 'PRODUCTION'] as const;
const staleProcessingAfterMs = 15 * 60 * 1_000;
const maxErrorLength = 160;

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function accountDeletionTableNamesFromEnvironment(): AccountDeletionTableNames {
  return {
    request: requiredEnvironmentVariable('ACCOUNT_DELETION_REQUEST_TABLE_NAME'),
    profile: requiredEnvironmentVariable('USER_PROFILE_TABLE_NAME'),
    customerLink: requiredEnvironmentVariable('CUSTOMER_LINK_TABLE_NAME'),
    webhook: requiredEnvironmentVariable('WEBHOOK_TABLE_NAME'),
    subscription: requiredEnvironmentVariable('SUBSCRIPTION_TABLE_NAME'),
    earnedPointAccount: requiredEnvironmentVariable('DISCIPOINT_ACCOUNT_TABLE_NAME'),
    earnedPointEvent: requiredEnvironmentVariable('DISCIPOINT_EARN_EVENT_TABLE_NAME'),
    syncedAlarm: requiredEnvironmentVariable('SYNCED_ALARM_TABLE_NAME'),
    wakeCompletion: requiredEnvironmentVariable('WAKE_COMPLETION_TABLE_NAME'),
    engagementEvent: requiredEnvironmentVariable('ENGAGEMENT_EVENT_TABLE_NAME'),
    habit: requiredEnvironmentVariable('HABIT_DEFINITION_TABLE_NAME'),
    habitOccurrence: requiredEnvironmentVariable('HABIT_OCCURRENCE_TABLE_NAME'),
    habitProgressEvent: requiredEnvironmentVariable('HABIT_PROGRESS_EVENT_TABLE_NAME'),
    usernameReservation: requiredEnvironmentVariable('USERNAME_RESERVATION_TABLE_NAME'),
    friendRequest: requiredEnvironmentVariable('FRIEND_REQUEST_TABLE_NAME'),
    friendConnection: requiredEnvironmentVariable('FRIEND_CONNECTION_TABLE_NAME'),
  };
}

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof Error && error.name === 'ConditionalCheckFailedException';

const asRequest = (item: Record<string, unknown>): AccountDeletionRequestRecord | undefined => {
  const status = item.status;
  if (
    status !== 'REQUESTED' &&
    status !== 'PROCESSING' &&
    status !== 'COMPLETED' &&
    status !== 'FAILED'
  ) {
    return undefined;
  }
  if (typeof item.id !== 'string' || typeof item.userId !== 'string') return undefined;
  return {
    id: item.id,
    userId: item.userId,
    status,
    attempts: typeof item.attempts === 'number' ? item.attempts : 0,
    requestedAt: typeof item.requestedAt === 'string' ? item.requestedAt : '',
    updatedAt: typeof item.updatedAt === 'string' ? item.updatedAt : '',
  };
};

const epochSeconds = (value: string): number => {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) throw new Error('Invalid deletion timestamp');
  return Math.floor(parsed / 1_000);
};

const errorCode = (error: unknown): string => {
  const value = error instanceof Error ? error.name : 'UNKNOWN_ERROR';
  return value.slice(0, maxErrorLength);
};

export class DynamoAccountDeletionStore implements AccountDeletionStore {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: AccountDeletionTableNames,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async listCandidates(now: string): Promise<AccountDeletionRequestRecord[]> {
    const staleBefore = new Date(Date.parse(now) - staleProcessingAfterMs).toISOString();
    const [requested, processing] = await Promise.all([
      this.queryRequests('REQUESTED', now),
      this.queryRequests('PROCESSING', staleBefore),
    ]);
    return [...requested, ...processing].slice(0, 25);
  }

  public async claim(request: AccountDeletionRequestRecord, now: string): Promise<boolean> {
    const staleBefore = new Date(Date.parse(now) - staleProcessingAfterMs).toISOString();
    const condition =
      request.status === 'PROCESSING'
        ? '#status = :processing AND #updatedAt <= :staleBefore'
        : '#status = :requested AND (attribute_not_exists(nextAttemptAt) OR nextAttemptAt <= :nowEpoch)';
    const values =
      request.status === 'PROCESSING'
        ? { ':processing': 'PROCESSING', ':staleBefore': staleBefore }
        : { ':requested': 'REQUESTED', ':nowEpoch': epochSeconds(now) };
    try {
      await this.client.send(
        new UpdateCommand({
          TableName: this.tables.request,
          Key: { id: request.id },
          UpdateExpression:
            'SET #status = :processing, #updatedAt = :now, attempts = if_not_exists(attempts, :zero) + :one REMOVE lastError, nextAttemptAt',
          ConditionExpression: condition,
          ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: {
            ...values,
            ':processing': 'PROCESSING',
            ':now': now,
            ':zero': 0,
            ':one': 1,
          },
        }),
      );
      return true;
    } catch (error) {
      if (isConditionalFailure(error)) return false;
      throw error;
    }
  }

  public async deleteUserData(userId: string): Promise<void> {
    await this.deleteById(this.tables.profile, userId);
    await this.deleteByIndex(this.tables.customerLink, 'byCanonicalUser', 'userId', userId);
    await this.deleteByIndex(this.tables.webhook, 'byUserAndReceivedAt', 'userId', userId);
    await this.deleteByIndex(this.tables.habitOccurrence, 'byUserAndCreatedAt', 'userId', userId);
    await this.deleteByIndex(
      this.tables.habitProgressEvent,
      'byUserAndCreatedAt',
      'userId',
      userId,
    );
    await this.deleteByIndex(this.tables.usernameReservation, 'byUserId', 'userId', userId);
    await this.deleteByIndex(this.tables.subscription, 'byUserAndEnvironment', 'userId', userId);

    for (const environment of environments) {
      const userEnvironment = `${userId}:${environment}`;
      await this.deleteByIndex(
        this.tables.earnedPointAccount,
        'byUserEnvironmentAndUpdatedAt',
        'userEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.earnedPointEvent,
        'byUserEnvironmentAndCreatedAt',
        'userEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.syncedAlarm,
        'byUserEnvironmentAndUpdatedAt',
        'userEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.wakeCompletion,
        'byUserEnvironmentAndCompletedAt',
        'userEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.engagementEvent,
        'byUserEnvironmentAndReceivedAt',
        'userEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.habit,
        'byUserEnvironmentAndUpdatedAt',
        'userEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.friendRequest,
        'byRequesterEnvironmentAndUpdatedAt',
        'requesterEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.friendRequest,
        'byRecipientEnvironmentAndUpdatedAt',
        'recipientEnvironment',
        userEnvironment,
      );
      await this.deleteByIndex(
        this.tables.friendConnection,
        'byUserEnvironmentAndCreatedAt',
        'userEnvironment',
        userEnvironment,
      );
    }
  }

  public async complete(request: AccountDeletionRequestRecord): Promise<void> {
    // The request record is operational state, not user content. Remove it
    // after server-side user data cleanup so it does not become a second
    // retention obligation.
    await this.client.send(
      new DeleteCommand({ TableName: this.tables.request, Key: { id: request.id } }),
    );
  }

  public async fail(
    request: AccountDeletionRequestRecord,
    now: string,
    error: unknown,
  ): Promise<void> {
    const backoffSeconds = Math.min(3_600, 60 * 2 ** Math.min(request.attempts, 6));
    await this.client.send(
      new UpdateCommand({
        TableName: this.tables.request,
        Key: { id: request.id },
        UpdateExpression:
          'SET #status = :requested, #updatedAt = :now, lastError = :error, nextAttemptAt = :nextAttemptAt',
        ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
        ExpressionAttributeValues: {
          ':requested': 'REQUESTED',
          ':now': now,
          ':error': errorCode(error),
          ':nextAttemptAt': epochSeconds(now) + backoffSeconds,
        },
      }),
    );
  }

  private async queryRequests(
    status: 'REQUESTED' | 'PROCESSING',
    timestamp: string,
  ): Promise<AccountDeletionRequestRecord[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: this.tables.request,
          IndexName: 'byStatusAndRequestedAt',
          KeyConditionExpression: '#status = :status',
          FilterExpression:
            status === 'REQUESTED'
              ? 'attribute_not_exists(nextAttemptAt) OR nextAttemptAt <= :timestamp'
              : '#updatedAt <= :timestamp',
          ExpressionAttributeNames: { '#status': 'status', '#updatedAt': 'updatedAt' },
          ExpressionAttributeValues: {
            ':status': status,
            ':timestamp': status === 'REQUESTED' ? epochSeconds(timestamp) : timestamp,
          },
          ExclusiveStartKey: exclusiveStartKey,
          Limit: 25,
        }),
      );
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined && items.length < 25);
    return items
      .map(asRequest)
      .filter((request): request is AccountDeletionRequestRecord => request !== undefined);
  }

  private async deleteByIndex(
    tableName: string,
    indexName: string,
    keyName: string,
    keyValue: string,
  ): Promise<void> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({
          TableName: tableName,
          IndexName: indexName,
          KeyConditionExpression: '#key = :value',
          ExpressionAttributeNames: { '#key': keyName },
          ExpressionAttributeValues: { ':value': keyValue },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    await this.deleteItems(tableName, items);
  }

  private async deleteById(tableName: string, id: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: tableName, Key: { id } }));
  }

  private async deleteItems(tableName: string, items: Record<string, unknown>[]): Promise<void> {
    const writes = items
      .filter(
        (item): item is Record<string, unknown> & { id: string } => typeof item.id === 'string',
      )
      .map((item): DocumentWriteRequest => ({ DeleteRequest: { Key: { id: item.id } } }));
    for (let start = 0; start < writes.length; start += 25) {
      let pending = writes.slice(start, start + 25);
      for (let attempt = 0; pending.length > 0 && attempt < 6; attempt += 1) {
        const response = await this.client.send(
          new BatchWriteCommand({ RequestItems: { [tableName]: pending } }),
        );
        pending = response.UnprocessedItems?.[tableName] ?? [];
        if (pending.length > 0)
          await new Promise((resolve) => setTimeout(resolve, 25 * 2 ** attempt));
      }
      if (pending.length > 0) throw new Error('DynamoDB deletion batch was not fully processed');
    }
  }
}

export interface AccountDeletionSummary {
  inspected: number;
  completed: number;
  failed: number;
}

export async function processAccountDeletions(
  store: AccountDeletionStore,
  now: string,
): Promise<AccountDeletionSummary> {
  const candidates = await store.listCandidates(now);
  const summary: AccountDeletionSummary = { inspected: candidates.length, completed: 0, failed: 0 };
  for (const request of candidates) {
    if (!(await store.claim(request, now))) continue;
    try {
      await store.deleteUserData(request.userId);
      await store.complete(request);
      summary.completed += 1;
    } catch (error) {
      summary.failed += 1;
      await store.fail(request, now, error);
    }
  }
  return summary;
}

export const handler = async (event: ScheduledEvent): Promise<AccountDeletionSummary> => {
  const summary = await processAccountDeletions(
    new DynamoAccountDeletionStore(accountDeletionTableNamesFromEnvironment()),
    event.time,
  );
  log('info', 'account_deletion_processing_completed', { ...summary });
  return summary;
};
