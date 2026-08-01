import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { RevenueCatEnvironment } from './config.js';
import { DomainError } from './domain.js';
import type { EngagementRepository } from './engagement-repository.js';
import type {
  EngagementEvent,
  RecordEngagementCommand,
  RecordEngagementResult,
} from './engagement-types.js';

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function engagementTableNameFromEnvironment(): string {
  return requiredEnvironmentVariable('ENGAGEMENT_EVENT_TABLE_NAME');
}

const matchesCommand = (
  item: Record<string, unknown>,
  command: RecordEngagementCommand,
  environment: RevenueCatEnvironment,
): boolean =>
  item.userId === command.userId &&
  item.environment === environment &&
  item.sessionId === command.sessionId &&
  item.name === command.name;

export class DynamoEngagementRepository implements EngagementRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tableName: string,
    private readonly environment: RevenueCatEnvironment,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async recordEngagement(
    command: RecordEngagementCommand,
    now: string,
  ): Promise<RecordEngagementResult> {
    const prior = await this.item(command.eventId);
    if (prior !== undefined) return this.duplicateResult(prior, command, now);

    const event: EngagementEvent = {
      ...command,
      environment: this.environment,
      userEnvironment: `${command.userId}:${this.environment}`,
      platform: 'IOS',
      receivedAt: now,
    };
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tableName,
          Item: event,
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
      return { accepted: true, duplicate: false, serverTimestamp: now };
    } catch (error) {
      if (!(error instanceof Error) || error.name !== 'ConditionalCheckFailedException') {
        throw error;
      }
      const concurrent = await this.item(command.eventId);
      if (concurrent === undefined) throw error;
      return this.duplicateResult(concurrent, command, now);
    }
  }

  private duplicateResult(
    item: Record<string, unknown>,
    command: RecordEngagementCommand,
    now: string,
  ): RecordEngagementResult {
    if (!matchesCommand(item, command, this.environment)) {
      throw new DomainError('ENGAGEMENT_EVENT_ID_ALREADY_USED');
    }
    return { accepted: true, duplicate: true, serverTimestamp: now };
  }

  private async item(id: string): Promise<Record<string, unknown> | undefined> {
    return (
      await this.client.send(
        new GetCommand({ TableName: this.tableName, Key: { id }, ConsistentRead: true }),
      )
    ).Item;
  }
}
