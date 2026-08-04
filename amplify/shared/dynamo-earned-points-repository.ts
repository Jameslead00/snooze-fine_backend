import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
} from '@aws-sdk/lib-dynamodb';
import type { RevenueCatEnvironment } from './config.js';
import type {
  DisciPointAccount,
  DisciPointEarnEvent,
  DisciPointAccountView,
  EarnPointsCommand,
  EarnPointsResult,
  PointAwardPage,
} from './earned-points-types.js';
import type { EarnedPointsRepository } from './earned-points-repository.js';
import { DomainError } from './domain.js';
import { sha256 } from './security.js';

export interface EarnedPointsTableNames {
  account: string;
  earnEvent: string;
}

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function earnedPointsTableNamesFromEnvironment(): EarnedPointsTableNames {
  return {
    account: requiredEnvironmentVariable('DISCIPOINT_ACCOUNT_TABLE_NAME'),
    earnEvent: requiredEnvironmentVariable('DISCIPOINT_EARN_EVENT_TABLE_NAME'),
  };
}

const userEnvironment = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${environment}`;

const accountId = (userId: string, environment: RevenueCatEnvironment): string =>
  userEnvironment(userId, environment);

const eventId = (command: EarnPointsCommand, environment: RevenueCatEnvironment): string =>
  sha256(`discipoint-earn:${userEnvironment(command.userId, environment)}:${command.qualification}:${command.sourceEventId}`);

const asAccount = (item: Record<string, unknown>): DisciPointAccount => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  userEnvironment: String(item.userEnvironment),
  currentPoints: Number(item.currentPoints),
  lifetimeEarned: Number(item.lifetimeEarned),
  version: Number(item.version),
  createdAt: String(item.createdAt),
  updatedAt: String(item.updatedAt),
});

const asEarnEvent = (item: Record<string, unknown>): DisciPointEarnEvent => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  userEnvironment: String(item.userEnvironment),
  qualification: item.qualification === 'HABIT_COMPLETION' ? 'HABIT_COMPLETION' : 'WAKE_COMPLETION',
  sourceEventId: String(item.sourceEventId),
  pointsEarned: Number(item.pointsEarned),
  pointsAfter: Number(item.pointsAfter),
  createdAt: String(item.createdAt),
});

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TransactionCanceledException' || error.name === 'ConditionalCheckFailedException');

/**
 * The earned-points ledger is intentionally independent of subscriptions,
 * snoozes, missed habits, ballots, and company contributions.  A source event
 * can earn once; no operation in this repository subtracts points.
 */
export class DynamoEarnedPointsRepository implements EarnedPointsRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: EarnedPointsTableNames,
    private readonly environment: RevenueCatEnvironment,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async getDisciPointAccount(
    userId: string,
    now: string,
  ): Promise<DisciPointAccountView> {
    const item = await this.item(this.tables.account, accountId(userId, this.environment));
    const account = item === undefined ? undefined : asAccount(item);
    return {
      currentPoints: Math.max(0, account?.currentPoints ?? 0),
      lifetimeEarned: Math.max(0, account?.lifetimeEarned ?? 0),
      serverTimestamp: now,
    };
  }

  public async earnPoints(command: EarnPointsCommand, now: string): Promise<EarnPointsResult> {
    if (!Number.isInteger(command.points) || command.points <= 0) {
      throw new DomainError('INVALID_DISCIPOINT_EARNING');
    }
    const id = eventId(command, this.environment);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const priorEventItem = await this.item(this.tables.earnEvent, id);
      if (priorEventItem !== undefined) {
        const priorEvent = asEarnEvent(priorEventItem);
        if (
          priorEvent.userId !== command.userId ||
          priorEvent.qualification !== command.qualification ||
          priorEvent.sourceEventId !== command.sourceEventId
        ) {
          throw new DomainError('DISCIPOINT_EVENT_ID_CONFLICT');
        }
        const account = await this.getDisciPointAccount(command.userId, now);
        return {
          duplicate: true,
          pointsEarned: priorEvent.pointsEarned,
          currentPoints: account.currentPoints,
          lifetimeEarned: account.lifetimeEarned,
          serverTimestamp: now,
        };
      }

      const key = accountId(command.userId, this.environment);
      const accountItem = await this.item(this.tables.account, key);
      const current = accountItem === undefined ? undefined : asAccount(accountItem);
      const pointsAfter = (current?.currentPoints ?? 0) + command.points;
      const lifetimeEarned = (current?.lifetimeEarned ?? 0) + command.points;
      const event: DisciPointEarnEvent = {
        id,
        userId: command.userId,
        environment: this.environment,
        userEnvironment: userEnvironment(command.userId, this.environment),
        qualification: command.qualification,
        sourceEventId: command.sourceEventId,
        pointsEarned: command.points,
        pointsAfter,
        createdAt: now,
      };
      const account: DisciPointAccount = {
        id: key,
        userId: command.userId,
        environment: this.environment,
        userEnvironment: userEnvironment(command.userId, this.environment),
        currentPoints: pointsAfter,
        lifetimeEarned,
        version: (current?.version ?? 0) + 1,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      };
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tables.earnEvent,
                  Item: event,
                  ConditionExpression: 'attribute_not_exists(id)',
                },
              },
              {
                Put: {
                  TableName: this.tables.account,
                  Item: account,
                  ConditionExpression:
                    current === undefined ? 'attribute_not_exists(id)' : '#version = :version',
                  ExpressionAttributeNames:
                    current === undefined ? undefined : { '#version': 'version' },
                  ExpressionAttributeValues:
                    current === undefined ? undefined : { ':version': current.version },
                },
              },
            ],
          }),
        );
        return {
          duplicate: false,
          pointsEarned: command.points,
          currentPoints: pointsAfter,
          lifetimeEarned,
          serverTimestamp: now,
        };
      } catch (error) {
        if (!isConditionalFailure(error) || attempt === 4) throw error;
      }
    }
    throw new DomainError('DISCIPOINT_EARNING_RETRY_EXHAUSTED');
  }

  public async listPointAwards(
    userId: string,
    limit: number,
    nextToken: string | undefined,
  ): Promise<PointAwardPage> {
    const exclusiveStartKey =
      nextToken === undefined
        ? undefined
        : (JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf8')) as Record<string, unknown>);
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tables.earnEvent,
        IndexName: 'byUserEnvironmentAndCreatedAt',
        KeyConditionExpression: 'userEnvironment = :key',
        ExpressionAttributeValues: { ':key': userEnvironment(userId, this.environment) },
        ScanIndexForward: false,
        Limit: Math.min(Math.max(limit, 1), 100),
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    return {
      items: (response.Items ?? []).map((item) => {
        const event = asEarnEvent(item);
        return {
          id: event.id,
          achievementType: event.qualification,
          pointsAwarded: event.pointsEarned,
          reasonCode: event.qualification,
          source: 'ACCOUNTABILITY_ENGINE',
          sourceEventId: event.sourceEventId,
          relatedEventId: undefined,
          earnedPointsTotalAfter: event.pointsAfter,
          ballotId: undefined,
          createdAt: event.createdAt,
        };
      }),
      nextToken:
        response.LastEvaluatedKey === undefined
          ? undefined
          : Buffer.from(JSON.stringify(response.LastEvaluatedKey), 'utf8').toString('base64url'),
    };
  }

  private async item(tableName: string, id: string): Promise<Record<string, unknown> | undefined> {
    return (
      await this.client.send(
        new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }),
      )
    ).Item;
  }
}
