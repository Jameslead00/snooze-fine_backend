import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { RevenueCatEnvironment } from './config.js';
import type { SubscriptionRepository } from './subscription-repository.js';
import type { SubscriptionState, SubscriptionStatus } from './types.js';

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export const subscriptionTableNameFromEnvironment = (): string =>
  requiredEnvironmentVariable('SUBSCRIPTION_TABLE_NAME');

const asStatus = (value: unknown): SubscriptionStatus => {
  const statuses: SubscriptionStatus[] = [
    'ACTIVE',
    'GRACE_PERIOD',
    'BILLING_ISSUE',
    'CANCELLED_PENDING_EXPIRY',
    'EXPIRED',
    'UNKNOWN',
  ];
  return typeof value === 'string' && statuses.includes(value as SubscriptionStatus)
    ? (value as SubscriptionStatus)
    : 'UNKNOWN';
};

const asSubscriptionState = (item: Record<string, unknown>): SubscriptionState => ({
  id: String(item.id),
  userId: String(item.userId),
  revenueCatAppUserId: String(item.revenueCatAppUserId),
  entitlementId: String(item.entitlementId),
  productId: String(item.productId),
  status: asStatus(item.status),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  originalPurchaseAt: String(item.originalPurchaseAt),
  currentPeriodStart: String(item.currentPeriodStart),
  currentPeriodEnd: String(item.currentPeriodEnd),
  autoRenew: typeof item.autoRenew === 'boolean' ? item.autoRenew : undefined,
  lastRevenueCatEventId: String(item.lastRevenueCatEventId),
  stateEventAt: String(item.stateEventAt),
  statusEffectiveAt: String(item.statusEffectiveAt),
  updatedAt: String(item.updatedAt),
});

export class DynamoSubscriptionRepository implements SubscriptionRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tableName: string,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async getSubscriptionState(
    userId: string,
    environment: RevenueCatEnvironment,
  ): Promise<SubscriptionState | undefined> {
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: 'byUserAndEnvironment',
        KeyConditionExpression: 'userId = :userId AND environment = :environment',
        ExpressionAttributeValues: { ':userId': userId, ':environment': environment },
        Limit: 1,
      }),
    );
    const item = response.Items?.[0];
    return item === undefined ? undefined : asSubscriptionState(item);
  }
}
