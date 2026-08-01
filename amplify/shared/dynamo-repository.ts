import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type TransactWriteCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { PLATFORM_CONFIG, type RevenueCatEnvironment } from './config.js';
import { DomainError } from './domain.js';
import { expectedDonationMicroUsd } from './money.js';
import type { ApplyRevenueCatInput, PlatformRepository, TransactionPage } from './repository.js';
import { sha256 } from './security.js';
import type {
  PointAccount,
  PointAccountView,
  PointPeriod,
  PointTransaction,
  RevenueCatProcessingResult,
  SettlementCandidate,
  SnoozeCommand,
  SnoozeResult,
  SubscriptionState,
  SubscriptionStatus,
  WebhookRecord,
} from './types.js';

export interface PlatformTableNames {
  userProfile: string;
  customerLink: string;
  webhook: string;
  subscription: string;
  period: string;
  account: string;
  transaction: string;
  snooze: string;
  settlement: string;
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
    period: requiredEnvironmentVariable('POINT_PERIOD_TABLE_NAME'),
    account: requiredEnvironmentVariable('POINT_ACCOUNT_TABLE_NAME'),
    transaction: requiredEnvironmentVariable('POINT_TRANSACTION_TABLE_NAME'),
    snooze: requiredEnvironmentVariable('SNOOZE_EVENT_TABLE_NAME'),
    settlement: requiredEnvironmentVariable('MONTHLY_SETTLEMENT_TABLE_NAME'),
  };
}

const isConditionalFailure = (error: unknown): boolean => {
  if (!(error instanceof Error)) return false;
  return (
    error.name === 'TransactionCanceledException' ||
    error.name === 'ConditionalCheckFailedException'
  );
};

const accountId = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${environment}`;
const subscriptionId = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${PLATFORM_CONFIG.entitlementId}:${environment}`;

const asWebhookRecord = (item: Record<string, unknown>): WebhookRecord => ({
  id: String(item.id),
  type: String(item.eventType),
  appUserId: typeof item.appUserId === 'string' ? item.appUserId : undefined,
  originalAppUserId:
    typeof item.originalAppUserId === 'string' ? item.originalAppUserId : undefined,
  aliases: Array.isArray(item.aliases) ? item.aliases.map(String) : [],
  transferredFrom: Array.isArray(item.transferredFrom) ? item.transferredFrom.map(String) : [],
  transferredTo: Array.isArray(item.transferredTo) ? item.transferredTo.map(String) : [],
  productId: typeof item.productId === 'string' ? item.productId : undefined,
  entitlementIds: Array.isArray(item.entitlementIds) ? item.entitlementIds.map(String) : [],
  eventAt: String(item.eventAt),
  purchasedAt: typeof item.purchasedAt === 'string' ? item.purchasedAt : undefined,
  expiresAt: typeof item.expirationAt === 'string' ? item.expirationAt : undefined,
  gracePeriodExpiresAt:
    typeof item.gracePeriodExpirationAt === 'string' ? item.gracePeriodExpirationAt : undefined,
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  autoRenew: typeof item.autoRenew === 'boolean' ? item.autoRenew : undefined,
  payloadHash: String(item.payloadHash),
  rawMetadata: JSON.stringify(item.rawMetadata ?? {}),
  userId: typeof item.userId === 'string' ? item.userId : undefined,
  status:
    item.status === 'PROCESSED' ||
    item.status === 'UNRESOLVED' ||
    item.status === 'IGNORED' ||
    item.status === 'FAILED'
      ? item.status
      : 'FAILED',
  error: typeof item.processingError === 'string' ? item.processingError : undefined,
  receivedAt: String(item.receivedAt),
  processedAt: String(item.processedAt),
});

const asAccount = (item: Record<string, unknown>): PointAccount => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  currentBalance: Number(item.currentBalance),
  activePeriodId: typeof item.activePeriodId === 'string' ? item.activePeriodId : undefined,
  lifetimeAllocated: Number(item.lifetimeAllocated),
  lifetimeDeducted: Number(item.lifetimeDeducted),
  version: Number(item.version),
  updatedAt: String(item.updatedAt),
});

const asPeriod = (item: Record<string, unknown>): PointPeriod => ({
  id: String(item.id),
  userId: String(item.userId),
  entitlementId: String(item.entitlementId),
  productId: String(item.productId),
  periodStart: String(item.periodStart),
  periodEnd: String(item.periodEnd),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  initialAllocation: Number(item.initialAllocation),
  currentRemaining: Number(item.currentRemaining),
  status: item.status === 'EXPIRED' ? 'EXPIRED' : 'ACTIVE',
  allocationTransactionId: String(item.allocationTransactionId),
  createdAt: String(item.createdAt),
  updatedAt: String(item.updatedAt),
});

const asSubscription = (item: Record<string, unknown>): SubscriptionState => ({
  id: String(item.id),
  userId: String(item.userId),
  revenueCatAppUserId: String(item.revenueCatAppUserId),
  entitlementId: String(item.entitlementId),
  productId: String(item.productId),
  status: String(item.status) as SubscriptionStatus,
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

const asTransaction = (item: Record<string, unknown>): PointTransaction => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  userEnvironment: String(item.userEnvironment),
  pointPeriodId: String(item.pointPeriodId),
  amount: Number(item.amount),
  transactionType: String(item.transactionType) as PointTransaction['transactionType'],
  reasonCode: String(item.reasonCode),
  source: String(item.source) as PointTransaction['source'],
  idempotencyKey: String(item.idempotencyKey),
  sourceEventId: String(item.sourceEventId),
  relatedEventId: typeof item.relatedEventId === 'string' ? item.relatedEventId : undefined,
  balanceAfter: Number(item.balanceAfter),
  createdAt: String(item.createdAt),
  metadataJson: item.metadataJson === undefined ? undefined : JSON.stringify(item.metadataJson),
});

function parseMetadata(value: string | undefined): unknown {
  if (value === undefined) return undefined;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return { value };
  }
}

export class DynamoPlatformRepository implements PlatformRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: PlatformTableNames,
    private readonly environment: RevenueCatEnvironment,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async resolveUserByRevenueCatIds(ids: string[]): Promise<string | undefined> {
    if (ids.length === 0) return undefined;
    const uniqueIds = [...new Set(ids)].slice(0, 100);
    const items = await this.batchGetItems(
      this.tables.customerLink,
      uniqueIds.map((id) => ({ id })),
      'id, userId',
    );
    const userIds = new Set(items.map((item) => String(item.userId)));
    if (userIds.size > 1) {
      throw new DomainError('CONFLICTING_REVENUECAT_LINKS');
    }
    return userIds.values().next().value;
  }

  public async applyRevenueCatEvent(
    input: ApplyRevenueCatInput,
  ): Promise<RevenueCatProcessingResult> {
    return this.applyRevenueCatEventAttempt(input, true, true, 0);
  }

  private async applyRevenueCatEventAttempt(
    input: ApplyRevenueCatInput,
    includeAllocation: boolean,
    includeSubscription: boolean,
    attempt: number,
  ): Promise<RevenueCatProcessingResult> {
    const existingWebhook = await this.getItem(this.tables.webhook, input.event.id);
    if (existingWebhook !== undefined) {
      const record = asWebhookRecord(existingWebhook);
      return {
        duplicate: true,
        status: record.status,
        allocatedPoints: 0,
        userId: record.userId,
      };
    }

    const now = input.webhook.processedAt;
    const webhookItem = {
      id: input.event.id,
      eventType: input.event.type,
      userId: input.webhook.userId,
      appUserId: input.event.appUserId,
      originalAppUserId: input.event.originalAppUserId,
      aliases: input.event.aliases,
      transferredFrom: input.event.transferredFrom,
      transferredTo: input.event.transferredTo,
      productId: input.event.productId,
      entitlementIds: input.event.entitlementIds,
      eventAt: input.event.eventAt,
      purchasedAt: input.event.purchasedAt,
      expirationAt: input.event.expiresAt,
      gracePeriodExpirationAt: input.event.gracePeriodExpiresAt,
      environment: input.event.environment,
      autoRenew: input.event.autoRenew,
      status: input.webhook.status,
      processingError: input.webhook.error,
      payloadHash: input.event.payloadHash,
      rawMetadata: parseMetadata(input.event.rawMetadata),
      receivedAt: input.webhook.receivedAt,
      processedAt: input.webhook.processedAt,
      createdAt: now,
      updatedAt: now,
    };

    const transactItems: NonNullable<TransactWriteCommandInput['TransactItems']> = [
      {
        Put: {
          TableName: this.tables.webhook,
          Item: webhookItem,
          ConditionExpression: 'attribute_not_exists(id)',
        },
      },
    ];

    if (includeSubscription && input.subscription !== undefined) {
      const currentSubscription = await this.getItem(
        this.tables.subscription,
        input.subscription.id,
      );
      const originalPurchaseAt =
        currentSubscription === undefined
          ? input.subscription.originalPurchaseAt
          : String(currentSubscription.originalPurchaseAt);
      transactItems.push({
        Put: {
          TableName: this.tables.subscription,
          Item: {
            ...input.subscription,
            originalPurchaseAt,
            stateEventAt: input.event.eventAt,
            createdAt: currentSubscription?.createdAt ?? now,
            updatedAt: now,
          },
          ConditionExpression: 'attribute_not_exists(id) OR stateEventAt <= :eventAt',
          ExpressionAttributeValues: { ':eventAt': input.event.eventAt },
        },
      });
    }

    let allocatedPoints = 0;
    const allocation = includeAllocation ? input.allocation : undefined;
    if (allocation !== undefined) {
      const existingPeriod = await this.getItem(this.tables.period, allocation.period.id);
      if (existingPeriod !== undefined) {
        return this.applyRevenueCatEventAttempt(input, false, includeSubscription, attempt + 1);
      }
      const id = accountId(allocation.period.userId, allocation.period.environment);
      const currentAccountItem = await this.getItem(this.tables.account, id);
      const currentAccount =
        currentAccountItem === undefined ? undefined : asAccount(currentAccountItem);
      const currentPeriodItem =
        currentAccount?.activePeriodId === undefined
          ? undefined
          : await this.getItem(this.tables.period, currentAccount.activePeriodId);
      const currentPeriod =
        currentPeriodItem === undefined ? undefined : asPeriod(currentPeriodItem);
      const shouldActivatePeriod =
        currentPeriod === undefined || allocation.period.periodStart > currentPeriod.periodStart;
      const nextAccount: PointAccount = {
        id,
        userId: allocation.period.userId,
        environment: allocation.period.environment,
        currentBalance: shouldActivatePeriod
          ? allocation.period.initialAllocation
          : (currentAccount?.currentBalance ?? allocation.period.initialAllocation),
        activePeriodId: shouldActivatePeriod
          ? allocation.period.id
          : currentAccount?.activePeriodId,
        lifetimeAllocated:
          (currentAccount?.lifetimeAllocated ?? 0) + allocation.period.initialAllocation,
        lifetimeDeducted: currentAccount?.lifetimeDeducted ?? 0,
        version: (currentAccount?.version ?? 0) + 1,
        updatedAt: now,
      };
      const transaction = {
        ...allocation.transaction,
        balanceAfter: allocation.period.initialAllocation,
        metadataJson: parseMetadata(allocation.transaction.metadataJson),
        updatedAt: now,
      };
      transactItems.push(
        {
          Put: {
            TableName: this.tables.period,
            Item: { ...allocation.period, updatedAt: now },
            ConditionExpression: 'attribute_not_exists(id)',
          },
        },
        {
          Put: {
            TableName: this.tables.transaction,
            Item: transaction,
            ConditionExpression: 'attribute_not_exists(id)',
          },
        },
        {
          Put: {
            TableName: this.tables.account,
            Item: { ...nextAccount, createdAt: currentAccountItem?.createdAt ?? now },
            ConditionExpression:
              currentAccount === undefined ? 'attribute_not_exists(id)' : 'version = :version',
            ExpressionAttributeValues:
              currentAccount === undefined ? undefined : { ':version': currentAccount.version },
          },
        },
      );
      allocatedPoints = allocation.period.initialAllocation;
    }

    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: transactItems,
        }),
      );
      return {
        duplicate: false,
        status: input.webhook.status,
        allocatedPoints,
        userId: input.webhook.userId,
      };
    } catch (error) {
      if (!isConditionalFailure(error) || attempt >= 4) throw error;
      const webhookAfterRace = await this.getItem(this.tables.webhook, input.event.id);
      if (webhookAfterRace !== undefined) {
        const record = asWebhookRecord(webhookAfterRace);
        return {
          duplicate: true,
          status: record.status,
          allocatedPoints: 0,
          userId: record.userId,
        };
      }
      const periodAfterRace =
        allocation === undefined
          ? undefined
          : await this.getItem(this.tables.period, allocation.period.id);
      if (periodAfterRace !== undefined) {
        return this.applyRevenueCatEventAttempt(input, false, includeSubscription, attempt + 1);
      }
      if (includeSubscription && input.subscription !== undefined) {
        const current = await this.getItem(this.tables.subscription, input.subscription.id);
        if (
          current !== undefined &&
          typeof current.stateEventAt === 'string' &&
          current.stateEventAt > input.event.eventAt
        ) {
          return this.applyRevenueCatEventAttempt(input, includeAllocation, false, attempt + 1);
        }
      }
      return this.applyRevenueCatEventAttempt(
        input,
        includeAllocation,
        includeSubscription,
        attempt + 1,
      );
    }
  }

  public async recordSnooze(command: SnoozeCommand, now: string): Promise<SnoozeResult> {
    const idempotencyKey = `snooze:${command.userId}:${command.snoozeEventId}`;
    const snoozeId = sha256(idempotencyKey);
    for (let attempt = 0; attempt < 4; attempt += 1) {
      const existing = await this.getItem(this.tables.snooze, snoozeId);
      if (existing !== undefined) {
        if (String(existing.userId) !== command.userId) {
          throw new DomainError('SNOOZE_ID_CONFLICT');
        }
        return {
          accepted: existing.status === 'ACCEPTED',
          duplicate: true,
          pointsDeducted: Number(existing.pointsDeducted),
          officialBalance: Number(existing.officialBalance),
          activePointPeriodId: String(existing.activePointPeriodId),
          serverTimestamp: String(existing.receivedAt),
        };
      }

      const accountKey = accountId(command.userId, this.environment);
      const stateKey = subscriptionId(command.userId, this.environment);
      const state = await this.client.send(
        new TransactGetCommand({
          TransactItems: [
            { Get: { TableName: this.tables.account, Key: { id: accountKey } } },
            { Get: { TableName: this.tables.subscription, Key: { id: stateKey } } },
          ],
        }),
      );
      const accountItem = state.Responses?.[0]?.Item;
      const subscriptionItem = state.Responses?.[1]?.Item;
      if (accountItem === undefined || subscriptionItem === undefined) {
        throw new DomainError('INELIGIBLE_SUBSCRIPTION');
      }
      const account = asAccount(accountItem);
      const subscription = asSubscription(subscriptionItem);
      if (
        account.userId !== command.userId ||
        subscription.userId !== command.userId ||
        !['ACTIVE', 'GRACE_PERIOD', 'BILLING_ISSUE', 'CANCELLED_PENDING_EXPIRY'].includes(
          subscription.status,
        ) ||
        subscription.currentPeriodEnd <= now ||
        account.activePeriodId === undefined
      ) {
        throw new DomainError('INELIGIBLE_SUBSCRIPTION');
      }
      const periodItem = await this.getItem(this.tables.period, account.activePeriodId);
      if (periodItem === undefined) throw new DomainError('NO_ACTIVE_POINT_PERIOD');
      const period = asPeriod(periodItem);
      if (
        period.userId !== command.userId ||
        period.environment !== this.environment ||
        period.status !== 'ACTIVE' ||
        period.periodEnd <= now
      ) {
        throw new DomainError('NO_ACTIVE_POINT_PERIOD');
      }

      const deducted = Math.min(
        PLATFORM_CONFIG.snoozePointDeduction,
        Math.max(0, account.currentBalance),
      );
      const balance = account.currentBalance - deducted;
      const transactionId = sha256(`transaction:${idempotencyKey}`);
      const result: SnoozeResult = {
        accepted: true,
        duplicate: false,
        pointsDeducted: deducted,
        officialBalance: balance,
        activePointPeriodId: period.id,
        serverTimestamp: now,
      };
      try {
        await this.client.send(
          new TransactWriteCommand({
            TransactItems: [
              {
                Put: {
                  TableName: this.tables.snooze,
                  Item: {
                    id: snoozeId,
                    userId: command.userId,
                    environment: this.environment,
                    alarmId: command.alarmId,
                    alarmOccurrenceId: command.alarmOccurrenceId,
                    occurredAt: command.occurredAt,
                    receivedAt: now,
                    status: 'ACCEPTED',
                    ledgerTransactionId: transactionId,
                    activePointPeriodId: period.id,
                    pointsDeducted: deducted,
                    officialBalance: balance,
                    clientAppVersion: command.clientAppVersion,
                    legacyPurchaseReference: command.legacyPurchaseReference,
                    createdAt: now,
                    updatedAt: now,
                  },
                  ConditionExpression: 'attribute_not_exists(id)',
                },
              },
              {
                Put: {
                  TableName: this.tables.transaction,
                  Item: {
                    id: transactionId,
                    userId: command.userId,
                    environment: this.environment,
                    userEnvironment: `${command.userId}:${this.environment}`,
                    pointPeriodId: period.id,
                    amount: -deducted,
                    transactionType: 'SNOOZE_DEDUCTION',
                    reasonCode: 'DISCIPOINT_SNOOZE',
                    source: 'IOS_APP',
                    idempotencyKey,
                    sourceEventId: command.snoozeEventId,
                    relatedEventId: command.alarmOccurrenceId,
                    balanceAfter: balance,
                    createdAt: now,
                    updatedAt: now,
                    metadataJson: {
                      alarmId: command.alarmId,
                      clientAppVersion: command.clientAppVersion,
                      legacyPurchaseReference: command.legacyPurchaseReference,
                    },
                  },
                  ConditionExpression: 'attribute_not_exists(id)',
                },
              },
              {
                Update: {
                  TableName: this.tables.account,
                  Key: { id: account.id },
                  UpdateExpression:
                    'SET currentBalance = :balance, lifetimeDeducted = lifetimeDeducted + :deducted, version = version + :one, updatedAt = :now',
                  ConditionExpression:
                    'version = :version AND activePeriodId = :periodId AND currentBalance = :oldBalance',
                  ExpressionAttributeValues: {
                    ':balance': balance,
                    ':deducted': deducted,
                    ':one': 1,
                    ':now': now,
                    ':version': account.version,
                    ':periodId': period.id,
                    ':oldBalance': account.currentBalance,
                  },
                },
              },
              {
                Update: {
                  TableName: this.tables.period,
                  Key: { id: period.id },
                  UpdateExpression: 'SET currentRemaining = :balance, updatedAt = :now',
                  ConditionExpression: 'userId = :userId AND currentRemaining = :oldBalance',
                  ExpressionAttributeValues: {
                    ':balance': balance,
                    ':now': now,
                    ':userId': command.userId,
                    ':oldBalance': account.currentBalance,
                  },
                },
              },
            ],
          }),
        );
        return result;
      } catch (error) {
        if (!isConditionalFailure(error) || attempt === 3) throw error;
      }
    }
    throw new DomainError('CONCURRENT_UPDATE_RETRY_EXHAUSTED');
  }

  public async linkRevenueCatCustomer(input: {
    userId: string;
    revenueCatAppUserId: string;
    originalAnonymousAppUserId: string | undefined;
    timezone: string;
    creatorCode: string | undefined;
    now: string;
  }): Promise<{ linked: boolean; duplicate: boolean }> {
    const ids = [
      ...new Set([
        input.revenueCatAppUserId,
        ...(input.originalAnonymousAppUserId === undefined
          ? []
          : [input.originalAnonymousAppUserId]),
      ]),
    ];
    const records = await this.batchGetItems(
      this.tables.customerLink,
      ids.map((id) => ({ id })),
    );
    if (records.some((record) => String(record.userId) !== input.userId)) {
      throw new DomainError('REVENUECAT_ID_ALREADY_LINKED');
    }
    const duplicate = records.length === ids.length;
    const transactionItems: NonNullable<TransactWriteCommandInput['TransactItems']> = ids.map(
      (id) => {
        const anonymousUpdate =
          input.originalAnonymousAppUserId === undefined
            ? ''
            : ', originalAnonymousAppUserId = :anonymousId';
        return {
          Update: {
            TableName: this.tables.customerLink,
            Key: { id },
            UpdateExpression: `SET userId = :userId, revenueCatAppUserId = :stableId${anonymousUpdate}, createdAt = if_not_exists(createdAt, :now), updatedAt = :now`,
            ConditionExpression: 'attribute_not_exists(id) OR userId = :userId',
            ExpressionAttributeValues: {
              ':userId': input.userId,
              ':stableId': input.revenueCatAppUserId,
              ...(input.originalAnonymousAppUserId === undefined
                ? {}
                : { ':anonymousId': input.originalAnonymousAppUserId }),
              ':now': input.now,
            },
          },
        };
      },
    );
    transactionItems.push({
      Update: {
        TableName: this.tables.userProfile,
        Key: { id: input.userId },
        UpdateExpression: `SET userId = :userId, #timezone = :timezone${
          input.creatorCode === undefined
            ? ''
            : ', creatorCode = if_not_exists(creatorCode, :creatorCode)'
        }, createdAt = if_not_exists(createdAt, :now), updatedAt = :now`,
        ConditionExpression: 'attribute_not_exists(id) OR userId = :userId',
        ExpressionAttributeNames: {
          '#timezone': 'timezone',
        },
        ExpressionAttributeValues: {
          ':userId': input.userId,
          ':timezone': input.timezone,
          ...(input.creatorCode === undefined ? {} : { ':creatorCode': input.creatorCode }),
          ':now': input.now,
        },
      },
    });
    try {
      await this.client.send(new TransactWriteCommand({ TransactItems: transactionItems }));
    } catch (error) {
      if (isConditionalFailure(error)) {
        throw new DomainError('REVENUECAT_ID_ALREADY_LINKED');
      }
      throw error;
    }
    return { linked: true, duplicate };
  }

  public async getPointAccountView(userId: string, now: string): Promise<PointAccountView> {
    const [accountItem, subscriptionItem] = await Promise.all([
      this.getItem(this.tables.account, accountId(userId, this.environment)),
      this.getItem(this.tables.subscription, subscriptionId(userId, this.environment)),
    ]);
    const account = accountItem === undefined ? undefined : asAccount(accountItem);
    const subscription =
      subscriptionItem === undefined ? undefined : asSubscription(subscriptionItem);
    const period =
      account?.activePeriodId === undefined
        ? undefined
        : await this.getItem(this.tables.period, account.activePeriodId);
    const parsedPeriod = period === undefined ? undefined : asPeriod(period);
    const balance = Math.max(0, account?.currentBalance ?? 0);
    const isEligible =
      account?.activePeriodId !== undefined &&
      subscription !== undefined &&
      ['ACTIVE', 'GRACE_PERIOD', 'BILLING_ISSUE', 'CANCELLED_PENDING_EXPIRY'].includes(
        subscription.status,
      ) &&
      subscription.currentPeriodEnd > now &&
      parsedPeriod !== undefined &&
      parsedPeriod.userId === userId &&
      parsedPeriod.environment === this.environment &&
      parsedPeriod.status === 'ACTIVE' &&
      parsedPeriod.periodEnd > now;
    return {
      isEligible,
      officialBalance: balance,
      activePointPeriodId: parsedPeriod?.id,
      initialAllocation: parsedPeriod?.initialAllocation ?? 0,
      pointsDeducted:
        (parsedPeriod?.initialAllocation ?? 0) - (parsedPeriod?.currentRemaining ?? 0),
      periodStart: parsedPeriod?.periodStart,
      periodEnd: parsedPeriod?.periodEnd,
      subscriptionStatus: subscription?.status ?? 'UNKNOWN',
      donationMicroUsd: expectedDonationMicroUsd(balance, PLATFORM_CONFIG.microUsdPerPoint),
      serverTimestamp: now,
    };
  }

  public async listPointTransactions(
    userId: string,
    limit: number,
    nextToken: string | undefined,
  ): Promise<TransactionPage> {
    const exclusiveStartKey =
      nextToken === undefined
        ? undefined
        : (JSON.parse(Buffer.from(nextToken, 'base64url').toString('utf8')) as Record<
            string,
            unknown
          >);
    const response = await this.client.send(
      new QueryCommand({
        TableName: this.tables.transaction,
        IndexName: 'byUserEnvironmentAndCreatedAt',
        KeyConditionExpression: 'userEnvironment = :key',
        ExpressionAttributeValues: { ':key': `${userId}:${this.environment}` },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    return {
      items: (response.Items ?? []).map(asTransaction),
      nextToken:
        response.LastEvaluatedKey === undefined
          ? undefined
          : Buffer.from(JSON.stringify(response.LastEvaluatedKey), 'utf8').toString('base64url'),
    };
  }

  public async listSettlementCandidates(
    _month: string,
    environment: RevenueCatEnvironment,
    cutoff: string,
  ): Promise<SettlementCandidate[]> {
    const periodItems: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new ScanCommand({
          TableName: this.tables.period,
          FilterExpression:
            '#environment = :environment AND periodStart <= :cutoff AND periodEnd > :cutoff',
          ExpressionAttributeNames: { '#environment': 'environment' },
          ExpressionAttributeValues: { ':environment': environment, ':cutoff': cutoff },
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );
      periodItems.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);

    const periods = periodItems.map(asPeriod);
    const subscriptions = new Map<string, SubscriptionState>();
    for (let offset = 0; offset < periods.length; offset += 100) {
      const userIds = [...new Set(periods.slice(offset, offset + 100).map((p) => p.userId))];
      if (userIds.length === 0) continue;
      const items = await this.batchGetItems(
        this.tables.subscription,
        userIds.map((userId) => ({ id: subscriptionId(userId, environment) })),
      );
      for (const item of items) {
        const subscription = asSubscription(item);
        subscriptions.set(subscription.userId, subscription);
      }
    }
    return periods.map((period) => ({
      userId: period.userId,
      environment: period.environment,
      resolved: subscriptions.has(period.userId),
      subscriptionStatus: subscriptions.get(period.userId)?.status ?? 'UNKNOWN',
      subscriptionStatusEffectiveAt:
        subscriptions.get(period.userId)?.statusEffectiveAt ?? period.periodStart,
      periodStart: period.periodStart,
      periodEnd: period.periodEnd,
      allocated: period.initialAllocation,
      remaining: period.currentRemaining,
    }));
  }

  public async saveSettlement(input: {
    id: string;
    month: string;
    environment: RevenueCatEnvironment;
    cutoff: string;
    calculation: {
      eligibleUserCount: number;
      totalAllocatedPoints: number;
      totalDeductedPoints: number;
      totalRemainingPoints: number;
      expectedDonationMicroUsd: number;
    };
    expectedDonationDisplay: string;
    now: string;
  }): Promise<{ duplicate: boolean }> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.tables.settlement,
          Item: {
            id: input.id,
            calendarMonth: input.month,
            environment: input.environment,
            mode: PLATFORM_CONFIG.settlementMode,
            ...input.calculation,
            expectedDonationMicroUsd: String(input.calculation.expectedDonationMicroUsd),
            donationRateMicroUsdPerPoint: PLATFORM_CONFIG.microUsdPerPoint,
            expectedDonationDisplay: input.expectedDonationDisplay,
            calculationVersion: PLATFORM_CONFIG.settlementCalculationVersion,
            cutoffAt: input.cutoff,
            status: 'CALCULATED',
            completedAt: input.now,
            calculationMetadata: {
              rule: 'latest eligible subscription period active at UTC calendar-month cutoff',
              actualDonationPaid: false,
            },
            createdAt: input.now,
            updatedAt: input.now,
          },
          ConditionExpression: 'attribute_not_exists(id)',
        }),
      );
      return { duplicate: false };
    } catch (error) {
      if (isConditionalFailure(error)) return { duplicate: true };
      throw error;
    }
  }

  private async getItem(
    tableName: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const response = await this.client.send(
      new GetCommand({ TableName: tableName, Key: { id }, ConsistentRead: true }),
    );
    return response.Item;
  }

  private async batchGetItems(
    tableName: string,
    keys: Record<string, unknown>[],
    projectionExpression?: string,
  ): Promise<Record<string, unknown>[]> {
    let pending = keys;
    const items: Record<string, unknown>[] = [];
    for (let attempt = 0; attempt < 4 && pending.length > 0; attempt += 1) {
      const response = await this.client.send(
        new BatchGetCommand({
          RequestItems: {
            [tableName]: {
              Keys: pending,
              ...(projectionExpression === undefined
                ? {}
                : { ProjectionExpression: projectionExpression }),
            },
          },
        }),
      );
      items.push(...(response.Responses?.[tableName] ?? []));
      pending = response.UnprocessedKeys?.[tableName]?.Keys ?? [];
    }
    if (pending.length > 0) throw new Error('DynamoDB batch read retry limit exceeded');
    return items;
  }
}
