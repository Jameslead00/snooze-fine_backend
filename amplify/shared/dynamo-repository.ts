import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { type RevenueCatEnvironment } from './config.js';
import { DomainError } from './domain.js';
import type { ApplyRevenueCatInput, PlatformRepository } from './repository.js';
import type { RevenueCatProcessingResult, SubscriptionState, WebhookRecord } from './types.js';

export interface PlatformTableNames {
  userProfile: string;
  customerLink: string;
  webhook: string;
  subscription: string;
}

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function tableNamesFromEnvironment(): PlatformTableNames {
  return {
    userProfile: requiredEnvironmentVariable('USER_PROFILE_TABLE_NAME'),
    customerLink: requiredEnvironmentVariable('CUSTOMER_LINK_TABLE_NAME'),
    webhook: requiredEnvironmentVariable('WEBHOOK_TABLE_NAME'),
    subscription: requiredEnvironmentVariable('SUBSCRIPTION_TABLE_NAME'),
  };
}

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TransactionCanceledException' || error.name === 'ConditionalCheckFailedException');

const asWebhookRecord = (item: Record<string, unknown>): WebhookRecord => ({
  id: String(item.id), type: String(item.eventType),
  appUserId: typeof item.appUserId === 'string' ? item.appUserId : undefined,
  originalAppUserId: typeof item.originalAppUserId === 'string' ? item.originalAppUserId : undefined,
  aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
  transferredFrom: Array.isArray(item.transferredFrom) ? item.transferredFrom.map(String) : [],
  transferredTo: Array.isArray(item.transferredTo) ? item.transferredTo.map(String) : [],
  productId: typeof item.productId === 'string' ? item.productId : undefined,
  entitlementIds: Array.isArray(item.entitlementIds) ? item.entitlementIds.map(String) : [],
  eventAt: String(item.eventAt),
  purchasedAt: typeof item.purchasedAt === 'string' ? item.purchasedAt : undefined,
  expiresAt: typeof item.expirationAt === 'string' ? item.expirationAt : undefined,
  gracePeriodExpiresAt: typeof item.gracePeriodExpirationAt === 'string' ? item.gracePeriodExpirationAt : undefined,
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  autoRenew: typeof item.autoRenew === 'boolean' ? item.autoRenew : undefined,
  payloadHash: String(item.payloadHash), rawMetadata: JSON.stringify(item.rawMetadata ?? {}),
  userId: typeof item.userId === 'string' ? item.userId : undefined,
  status: item.status === 'PROCESSED' || item.status === 'UNRESOLVED' || item.status === 'IGNORED' ? item.status : 'FAILED',
  error: typeof item.processingError === 'string' ? item.processingError : undefined,
  receivedAt: String(item.receivedAt), processedAt: String(item.processedAt),
});

const parseMetadata = (value: string): unknown => {
  try { return JSON.parse(value) as unknown; } catch { return { value }; }
};

export class DynamoPlatformRepository implements PlatformRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(private readonly tables: PlatformTableNames, _environment: RevenueCatEnvironment, client?: DynamoDBDocumentClient) {
    this.client = client ?? DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  }

  public async resolveUserByRevenueCatIds(ids: string[]): Promise<string | undefined> {
    const uniqueIds = [...new Set(ids)].slice(0, 100);
    if (uniqueIds.length === 0) return undefined;
    const records = await this.batchGetItems(this.tables.customerLink, uniqueIds.map((id) => ({ id })), 'id, userId');
    const userIds = new Set(records.map((record) => String(record.userId)));
    if (userIds.size > 1) throw new DomainError('CONFLICTING_REVENUECAT_LINKS');
    return userIds.values().next().value;
  }

  public async applyRevenueCatEvent(input: ApplyRevenueCatInput): Promise<RevenueCatProcessingResult> {
    const existing = await this.getItem(this.tables.webhook, input.event.id);
    if (existing !== undefined) {
      const webhook = asWebhookRecord(existing);
      return { duplicate: true, status: webhook.status, allocatedPoints: 0, userId: webhook.userId };
    }
    const now = input.webhook.processedAt;
    const writes: NonNullable<TransactWriteCommandInput['TransactItems']> = [{ Put: { TableName: this.tables.webhook, Item: {
      id: input.event.id, eventType: input.event.type, userId: input.webhook.userId,
      appUserId: input.event.appUserId, originalAppUserId: input.event.originalAppUserId,
      aliases: input.event.aliases, transferredFrom: input.event.transferredFrom, transferredTo: input.event.transferredTo,
      productId: input.event.productId, entitlementIds: input.event.entitlementIds, eventAt: input.event.eventAt,
      purchasedAt: input.event.purchasedAt, expirationAt: input.event.expiresAt,
      gracePeriodExpirationAt: input.event.gracePeriodExpiresAt, environment: input.event.environment,
      autoRenew: input.event.autoRenew, status: input.webhook.status, processingError: input.webhook.error,
      payloadHash: input.event.payloadHash, rawMetadata: parseMetadata(input.event.rawMetadata),
      receivedAt: input.webhook.receivedAt, processedAt: input.webhook.processedAt, createdAt: now, updatedAt: now,
    }, ConditionExpression: 'attribute_not_exists(id)' } }];
    if (input.subscription !== undefined) {
      const current = await this.getItem(this.tables.subscription, input.subscription.id);
      writes.push({ Put: { TableName: this.tables.subscription, Item: {
        ...input.subscription,
        originalPurchaseAt: current === undefined ? input.subscription.originalPurchaseAt : String(current.originalPurchaseAt),
        createdAt: current?.createdAt ?? now, updatedAt: now,
      }, ConditionExpression: 'attribute_not_exists(id) OR stateEventAt <= :eventAt', ExpressionAttributeValues: { ':eventAt': input.event.eventAt } } });
    }
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: writes }));
      return { duplicate: false, status: input.webhook.status, allocatedPoints: 0, userId: input.webhook.userId };
    } catch (error) {
      if (!isConditionalFailure(error)) throw error;
      const raced = await this.getItem(this.tables.webhook, input.event.id);
      if (raced !== undefined) {
        const webhook = asWebhookRecord(raced);
        return { duplicate: true, status: webhook.status, allocatedPoints: 0, userId: webhook.userId };
      }
      throw error;
    }
  }

  public async reconcileRevenueCatSubscription(input: {
    subscription: SubscriptionState;
    now: string;
  }): Promise<void> {
    const current = await this.getItem(this.tables.subscription, input.subscription.id);
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.subscription,
          Item: {
            ...input.subscription,
            originalPurchaseAt:
              current === undefined
                ? input.subscription.originalPurchaseAt
                : String(current.originalPurchaseAt),
            createdAt: current?.createdAt ?? input.now,
            updatedAt: input.now,
          },
          ConditionExpression: 'attribute_not_exists(id) OR stateEventAt <= :stateEventAt',
          ExpressionAttributeValues: { ':stateEventAt': input.subscription.stateEventAt },
        }),
      );
    } catch (error) {
      // A webhook with newer state may win a race with this explicit lookup.
      // Keeping that newer state is the correct result for the caller.
      if (!isConditionalFailure(error)) throw error;
    }
  }

  public async linkRevenueCatCustomer(input: { userId: string; revenueCatAppUserId: string; originalAnonymousAppUserId: string | undefined; timezone: string; creatorCode: string | undefined; now: string }): Promise<{ linked: boolean; duplicate: boolean }> {
    const ids = [...new Set([input.revenueCatAppUserId, ...(input.originalAnonymousAppUserId ? [input.originalAnonymousAppUserId] : [])])];
    const records = await this.batchGetItems(this.tables.customerLink, ids.map((id) => ({ id })));
    if (records.some((record) => String(record.userId) !== input.userId)) throw new DomainError('REVENUECAT_ID_ALREADY_LINKED');
    const writes: NonNullable<TransactWriteCommandInput['TransactItems']> = ids.map((id) => ({ Update: {
      TableName: this.tables.customerLink, Key: { id },
      UpdateExpression: 'SET userId = :userId, revenueCatAppUserId = :stableId, createdAt = if_not_exists(createdAt, :now), updatedAt = :now',
      ConditionExpression: 'attribute_not_exists(id) OR userId = :userId',
      ExpressionAttributeValues: { ':userId': input.userId, ':stableId': input.revenueCatAppUserId, ':now': input.now },
    } }));
    writes.push({ Update: { TableName: this.tables.userProfile, Key: { id: input.userId },
      UpdateExpression: `SET userId = :userId, #timezone = :timezone${input.creatorCode === undefined ? '' : ', creatorCode = if_not_exists(creatorCode, :creatorCode)'}, createdAt = if_not_exists(createdAt, :now), updatedAt = :now`,
      ConditionExpression: 'attribute_not_exists(id) OR userId = :userId', ExpressionAttributeNames: { '#timezone': 'timezone' },
      ExpressionAttributeValues: { ':userId': input.userId, ':timezone': input.timezone, ...(input.creatorCode === undefined ? {} : { ':creatorCode': input.creatorCode }), ':now': input.now },
    } });
    try { await this.client.send(new TransactWriteCommand({ TransactItems: writes })); }
    catch (error) { if (isConditionalFailure(error)) throw new DomainError('REVENUECAT_ID_ALREADY_LINKED'); throw error; }
    return { linked: true, duplicate: records.length === ids.length };
  }

  private async getItem(tableName: string, id: string): Promise<Record<string, unknown> | undefined> {
    return (await this.client.send(new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }))).Item;
  }

  private async batchGetItems(tableName: string, keys: Record<string, unknown>[], projectionExpression?: string): Promise<Record<string, unknown>[]> {
    const response = await this.client.send(new BatchGetCommand({ RequestItems: { [tableName]: { Keys: keys, ...(projectionExpression === undefined ? {} : { ProjectionExpression: projectionExpression }) } } }));
    if ((response.UnprocessedKeys?.[tableName]?.Keys?.length ?? 0) > 0) throw new Error('DynamoDB batch read retry limit exceeded');
    return response.Responses?.[tableName] ?? [];
  }
}
