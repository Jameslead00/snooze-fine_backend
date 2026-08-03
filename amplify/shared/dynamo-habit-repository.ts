import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  TransactGetCommand,
  TransactWriteCommand,
  type QueryCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { PLATFORM_CONFIG, type RevenueCatEnvironment } from './config.js';
import { DomainError } from './domain.js';
import type { HabitRepository } from './habit-repository.js';
import { defaultHabitStepValue } from './habit-types.js';
import type {
  HabitDefinition,
  HabitOccurrence,
  HabitProgressResult,
  HabitSettlementResult,
  SaveHabitCommand,
} from './habit-types.js';
import { sha256 } from './security.js';
import type { PointAccount, PointPeriod, SubscriptionState } from './types.js';

export interface HabitTableNames {
  habit: string;
  occurrence: string;
  progressEvent: string;
  subscription: string;
  period: string;
  account: string;
  transaction: string;
}

const requiredEnvironmentVariable = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.length === 0) throw new Error(`${name} is not configured`);
  return value;
};

export function habitTableNamesFromEnvironment(): HabitTableNames {
  return {
    habit: requiredEnvironmentVariable('HABIT_DEFINITION_TABLE_NAME'),
    occurrence: requiredEnvironmentVariable('HABIT_OCCURRENCE_TABLE_NAME'),
    progressEvent: requiredEnvironmentVariable('HABIT_PROGRESS_EVENT_TABLE_NAME'),
    subscription: requiredEnvironmentVariable('SUBSCRIPTION_TABLE_NAME'),
    period: requiredEnvironmentVariable('POINT_PERIOD_TABLE_NAME'),
    account: requiredEnvironmentVariable('POINT_ACCOUNT_TABLE_NAME'),
    transaction: requiredEnvironmentVariable('POINT_TRANSACTION_TABLE_NAME'),
  };
}

const isConditionalFailure = (error: unknown): boolean =>
  error instanceof Error &&
  (error.name === 'TransactionCanceledException' ||
    error.name === 'ConditionalCheckFailedException');

const accountId = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${environment}`;
const subscriptionId = (userId: string, environment: RevenueCatEnvironment): string =>
  `${userId}:${PLATFORM_CONFIG.entitlementId}:${environment}`;

const asHabit = (item: Record<string, unknown>): HabitDefinition => {
  const kind = String(item.kind) as HabitDefinition['kind'];
  const targetValue = Number(item.targetValue);
  const storedStepValue = Number(item.stepValue);
  const stepValue =
    Number.isInteger(storedStepValue) && storedStepValue > 0
      ? Math.min(storedStepValue, targetValue)
      : Math.min(defaultHabitStepValue(kind), targetValue);
  return {
    id: String(item.id),
    userId: String(item.userId),
    environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    userEnvironment: String(item.userEnvironment),
    environmentState: String(item.environmentState),
    kind,
    title: String(item.title),
    targetValue,
    stepValue,
    unit: String(item.unit) as HabitDefinition['unit'],
    weekdays: Array.isArray(item.weekdays) ? item.weekdays.map(Number) : [],
    deadlineMinutes: Number(item.deadlineMinutes),
    timezone: String(item.timezone),
    penaltyPoints: Number(item.penaltyPoints),
    startDate: String(item.startDate),
    activeState: item.activeState === 'ARCHIVED' ? 'ARCHIVED' : 'ACTIVE',
    version: Number(item.version),
    createdAt: String(item.createdAt),
    updatedAt: String(item.updatedAt),
  };
};

const asOccurrence = (item: Record<string, unknown>): HabitOccurrence => ({
  id: String(item.id),
  userId: String(item.userId),
  environment: item.environment === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  userEnvironmentDate: String(item.userEnvironmentDate),
  habitId: String(item.habitId),
  localDate: String(item.localDate),
  dueAt: String(item.dueAt),
  targetValue: Number(item.targetValue),
  unit: String(item.unit) as HabitOccurrence['unit'],
  progressValue: Number(item.progressValue),
  status: String(item.status) as HabitOccurrence['status'],
  completedAt: typeof item.completedAt === 'string' ? item.completedAt : undefined,
  missedAt: typeof item.missedAt === 'string' ? item.missedAt : undefined,
  ledgerTransactionId:
    typeof item.ledgerTransactionId === 'string' ? item.ledgerTransactionId : undefined,
  pointsDeducted: Number(item.pointsDeducted),
  officialBalance: Number(item.officialBalance),
  version: Number(item.version),
  createdAt: String(item.createdAt),
  updatedAt: String(item.updatedAt),
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
  status: String(item.status) as SubscriptionState['status'],
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

export class DynamoHabitRepository implements HabitRepository {
  private readonly client: DynamoDBDocumentClient;

  public constructor(
    private readonly tables: HabitTableNames,
    private readonly environment: RevenueCatEnvironment,
    client?: DynamoDBDocumentClient,
  ) {
    this.client =
      client ??
      DynamoDBDocumentClient.from(new DynamoDBClient({}), {
        marshallOptions: { removeUndefinedValues: true },
      });
  }

  public async listHabits(userId: string): Promise<HabitDefinition[]> {
    const items = await this.queryAll({
      TableName: this.tables.habit,
      IndexName: 'byUserEnvironmentAndUpdatedAt',
      KeyConditionExpression: 'userEnvironment = :value',
      ExpressionAttributeValues: { ':value': `${userId}:${this.environment}` },
      ScanIndexForward: false,
    });
    return items.map((item) => asHabit(item));
  }

  public async getHabit(userId: string, habitId: string): Promise<HabitDefinition | undefined> {
    const item = await this.getItem(this.tables.habit, habitId);
    if (item === undefined) return undefined;
    const habit = asHabit(item);
    return habit.userId === userId && habit.environment === this.environment ? habit : undefined;
  }

  public async saveHabit(
    command: SaveHabitCommand,
    startDate: string,
    penaltyPoints: number,
    now: string,
  ): Promise<HabitDefinition> {
    const currentItem = await this.getItem(this.tables.habit, command.habitId);
    if (currentItem !== undefined && String(currentItem.userId) !== command.userId) {
      throw new DomainError('HABIT_ID_ALREADY_USED');
    }
    const current = currentItem === undefined ? undefined : asHabit(currentItem);
    const habit: HabitDefinition = {
      id: command.habitId,
      userId: command.userId,
      environment: this.environment,
      userEnvironment: `${command.userId}:${this.environment}`,
      environmentState: `${this.environment}:ACTIVE`,
      kind: command.kind,
      title: command.title,
      targetValue: command.targetValue,
      stepValue: command.stepValue,
      unit: command.unit,
      weekdays: command.weekdays,
      deadlineMinutes: command.deadlineMinutes,
      timezone: command.timezone,
      penaltyPoints,
      startDate: current?.startDate ?? startDate,
      activeState: 'ACTIVE',
      version: (current?.version ?? 0) + 1,
      createdAt: current?.createdAt ?? now,
      updatedAt: now,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tables.habit,
        Item: habit,
        ConditionExpression:
          current === undefined ? 'attribute_not_exists(id)' : '#version = :version',
        ExpressionAttributeNames: current === undefined ? undefined : { '#version': 'version' },
        ExpressionAttributeValues:
          current === undefined ? undefined : { ':version': current.version },
      }),
    );
    return habit;
  }

  public async archiveHabit(
    userId: string,
    habitId: string,
    now: string,
  ): Promise<HabitDefinition> {
    const current = await this.getHabit(userId, habitId);
    if (current === undefined) throw new DomainError('HABIT_NOT_FOUND');
    const archived: HabitDefinition = {
      ...current,
      activeState: 'ARCHIVED',
      environmentState: `${this.environment}:ARCHIVED`,
      version: current.version + 1,
      updatedAt: now,
    };
    await this.client.send(
      new PutCommand({
        TableName: this.tables.habit,
        Item: archived,
        ConditionExpression: 'userId = :userId AND #version = :version',
        ExpressionAttributeNames: { '#version': 'version' },
        ExpressionAttributeValues: { ':userId': userId, ':version': current.version },
      }),
    );
    return archived;
  }

  public async recordHabitProgress(
    input: Parameters<HabitRepository['recordHabitProgress']>[0],
  ): Promise<HabitProgressResult> {
    return this.recordHabitProgressAttempt(input, 0);
  }

  private async recordHabitProgressAttempt(
    input: Parameters<HabitRepository['recordHabitProgress']>[0],
    attempt: number,
  ): Promise<HabitProgressResult> {
    const priorEvent = await this.getItem(this.tables.progressEvent, input.command.progressEventId);
    if (priorEvent !== undefined) {
      if (
        String(priorEvent.userId) !== input.command.userId ||
        String(priorEvent.habitId) !== input.command.habitId
      ) {
        throw new DomainError('PROGRESS_EVENT_ID_ALREADY_USED');
      }
      const stored = await this.getItem(this.tables.occurrence, String(priorEvent.occurrenceId));
      if (stored === undefined) throw new DomainError('PROGRESS_EVENT_INCOMPLETE');
      const officialBalance = await this.officialBalance(input.command.userId);
      return this.progressResult(asOccurrence(stored), true, input.now, officialBalance);
    }

    const currentItem = await this.getItem(this.tables.occurrence, input.occurrence.id);
    const current = currentItem === undefined ? undefined : asOccurrence(currentItem);
    if (current?.status === 'MISSED' || current?.status === 'SKIPPED_INELIGIBLE') {
      throw new DomainError('HABIT_ALREADY_SETTLED');
    }
    const progressValue = Math.min(
      input.habit.targetValue,
      (current?.progressValue ?? 0) + input.command.amount,
    );
    const completed = progressValue >= input.habit.targetValue;
    const occurrence: HabitOccurrence = {
      ...(current ?? input.occurrence),
      progressValue,
      status: completed ? 'COMPLETED' : 'PENDING',
      completedAt: completed ? input.command.occurredAt : current?.completedAt,
      version: (current?.version ?? 0) + 1,
      updatedAt: input.now,
    };
    const progressEvent = {
      id: input.command.progressEventId,
      userId: input.command.userId,
      habitId: input.command.habitId,
      occurrenceId: occurrence.id,
      amount: input.command.amount,
      occurredAt: input.command.occurredAt,
      progressAfter: progressValue,
      completed,
      createdAt: input.now,
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.progressEvent,
                Item: progressEvent,
                ConditionExpression: 'attribute_not_exists(id)',
              },
            },
            {
              Put: {
                TableName: this.tables.occurrence,
                Item: occurrence,
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
      const officialBalance = await this.officialBalance(input.command.userId);
      return this.progressResult(occurrence, false, input.now, officialBalance);
    } catch (error) {
      if (!isConditionalFailure(error) || attempt >= 4) throw error;
      return this.recordHabitProgressAttempt(input, attempt + 1);
    }
  }

  public async listActiveHabits(): Promise<HabitDefinition[]> {
    const items = await this.queryAll({
      TableName: this.tables.habit,
      IndexName: 'byEnvironmentStateAndUpdatedAt',
      KeyConditionExpression: 'environmentState = :value',
      ExpressionAttributeValues: { ':value': `${this.environment}:ACTIVE` },
    });
    return items.map((item) => asHabit(item));
  }

  public async settleMissedHabit(
    input: Parameters<HabitRepository['settleMissedHabit']>[0],
  ): Promise<HabitSettlementResult> {
    return this.settleMissedHabitAttempt(input, 0);
  }

  private async settleMissedHabitAttempt(
    input: Parameters<HabitRepository['settleMissedHabit']>[0],
    attempt: number,
  ): Promise<HabitSettlementResult> {
    const currentItem = await this.getItem(this.tables.occurrence, input.occurrence.id);
    const current = currentItem === undefined ? undefined : asOccurrence(currentItem);
    if (current !== undefined && current.status !== 'PENDING') {
      return {
        duplicate: true,
        status: current.status,
        pointsDeducted: current.pointsDeducted,
        officialBalance: current.officialBalance,
      };
    }

    const accountKey = accountId(input.habit.userId, this.environment);
    const subscriptionKey = subscriptionId(input.habit.userId, this.environment);
    const state = await this.client.send(
      new TransactGetCommand({
        TransactItems: [
          { Get: { TableName: this.tables.account, Key: { id: accountKey } } },
          { Get: { TableName: this.tables.subscription, Key: { id: subscriptionKey } } },
        ],
      }),
    );
    const accountItem = state.Responses?.[0]?.Item;
    const subscriptionItem = state.Responses?.[1]?.Item;
    const account = accountItem === undefined ? undefined : asAccount(accountItem);
    const subscription =
      subscriptionItem === undefined ? undefined : asSubscription(subscriptionItem);
    const periodItem =
      account?.activePeriodId === undefined
        ? undefined
        : await this.getItem(this.tables.period, account.activePeriodId);
    const period = periodItem === undefined ? undefined : asPeriod(periodItem);
    const eligible =
      account !== undefined &&
      period !== undefined &&
      subscription !== undefined &&
      ['ACTIVE', 'GRACE_PERIOD', 'BILLING_ISSUE', 'CANCELLED_PENDING_EXPIRY'].includes(
        subscription.status,
      ) &&
      subscription.currentPeriodStart <= input.occurrence.dueAt &&
      subscription.currentPeriodEnd > input.occurrence.dueAt &&
      period.status === 'ACTIVE' &&
      period.userId === input.habit.userId &&
      period.periodStart <= input.occurrence.dueAt &&
      period.periodEnd > input.occurrence.dueAt;

    if (!eligible || account === undefined || period === undefined) {
      const skipped: HabitOccurrence = {
        ...(current ?? input.occurrence),
        status: 'SKIPPED_INELIGIBLE',
        missedAt: input.now,
        officialBalance: account?.currentBalance ?? 0,
        version: (current?.version ?? 0) + 1,
        updatedAt: input.now,
      };
      try {
        await this.putOccurrence(skipped, current);
        return {
          duplicate: false,
          status: skipped.status,
          pointsDeducted: 0,
          officialBalance: skipped.officialBalance,
        };
      } catch (error) {
        if (!isConditionalFailure(error) || attempt >= 4) throw error;
        return this.settleMissedHabitAttempt(input, attempt + 1);
      }
    }

    const pointsDeducted = Math.min(input.habit.penaltyPoints, account.currentBalance);
    const officialBalance = account.currentBalance - pointsDeducted;
    const idempotencyKey = `habit-miss:${input.habit.userId}:${input.occurrence.id}`;
    const transactionId = sha256(`transaction:${idempotencyKey}`);
    const missed: HabitOccurrence = {
      ...(current ?? input.occurrence),
      status: 'MISSED',
      missedAt: input.now,
      ledgerTransactionId: transactionId,
      pointsDeducted,
      officialBalance,
      version: (current?.version ?? 0) + 1,
      updatedAt: input.now,
    };
    const transaction = {
      id: transactionId,
      userId: input.habit.userId,
      environment: this.environment,
      userEnvironment: input.habit.userEnvironment,
      pointPeriodId: period.id,
      amount: -pointsDeducted,
      transactionType: 'HABIT_DEDUCTION',
      reasonCode: 'MISSED_HABIT',
      source: 'ACCOUNTABILITY_ENGINE',
      idempotencyKey,
      sourceEventId: input.occurrence.id,
      relatedEventId: input.habit.id,
      balanceAfter: officialBalance,
      createdAt: input.now,
      metadataJson: {
        habitKind: input.habit.kind,
        localDate: input.occurrence.localDate,
        dueAt: input.occurrence.dueAt,
      },
    };
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tables.occurrence,
                Item: missed,
                ConditionExpression:
                  current === undefined
                    ? 'attribute_not_exists(id)'
                    : '#version = :occurrenceVersion AND #status = :pending',
                ExpressionAttributeNames:
                  current === undefined
                    ? undefined
                    : { '#version': 'version', '#status': 'status' },
                ExpressionAttributeValues:
                  current === undefined
                    ? undefined
                    : { ':occurrenceVersion': current.version, ':pending': 'PENDING' },
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
              Update: {
                TableName: this.tables.account,
                Key: { id: account.id },
                UpdateExpression:
                  'SET currentBalance = :balance, lifetimeDeducted = lifetimeDeducted + :deducted, #version = #version + :one, updatedAt = :now',
                ConditionExpression: '#version = :version AND activePeriodId = :periodId',
                ExpressionAttributeNames: { '#version': 'version' },
                ExpressionAttributeValues: {
                  ':balance': officialBalance,
                  ':deducted': pointsDeducted,
                  ':one': 1,
                  ':now': input.now,
                  ':version': account.version,
                  ':periodId': period.id,
                },
              },
            },
            {
              Update: {
                TableName: this.tables.period,
                Key: { id: period.id },
                UpdateExpression: 'SET currentRemaining = :balance, updatedAt = :now',
                ConditionExpression:
                  '#status = :active AND currentRemaining = :previousBalance AND periodEnd > :dueAt',
                ExpressionAttributeNames: { '#status': 'status' },
                ExpressionAttributeValues: {
                  ':balance': officialBalance,
                  ':now': input.now,
                  ':active': 'ACTIVE',
                  ':previousBalance': account.currentBalance,
                  ':dueAt': input.occurrence.dueAt,
                },
              },
            },
          ],
        }),
      );
      return {
        duplicate: false,
        status: missed.status,
        pointsDeducted,
        officialBalance,
      };
    } catch (error) {
      if (!isConditionalFailure(error) || attempt >= 4) throw error;
      return this.settleMissedHabitAttempt(input, attempt + 1);
    }
  }

  public async officialBalance(userId: string): Promise<number> {
    const item = await this.getItem(this.tables.account, accountId(userId, this.environment));
    return item === undefined ? 0 : Number(item.currentBalance);
  }

  public async listOccurrences(userId: string, localDate: string): Promise<HabitOccurrence[]> {
    const items = await this.queryAll({
      TableName: this.tables.occurrence,
      IndexName: 'byUserEnvironmentDateAndHabitId',
      KeyConditionExpression: 'userEnvironmentDate = :value',
      ExpressionAttributeValues: {
        ':value': `${userId}:${this.environment}:${localDate}`,
      },
    });
    return items.map((item) => asOccurrence(item));
  }

  private progressResult(
    occurrence: HabitOccurrence,
    duplicate: boolean,
    now: string,
    officialBalance: number,
  ): HabitProgressResult {
    return {
      accepted: true,
      duplicate,
      completed: occurrence.status === 'COMPLETED',
      localDate: occurrence.localDate,
      progressValue: occurrence.progressValue,
      targetValue: occurrence.targetValue,
      status: occurrence.status,
      officialBalance,
      serverTimestamp: now,
    };
  }

  private async putOccurrence(
    occurrence: HabitOccurrence,
    current: HabitOccurrence | undefined,
  ): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tables.occurrence,
        Item: occurrence,
        ConditionExpression:
          current === undefined ? 'attribute_not_exists(id)' : '#version = :version',
        ExpressionAttributeNames: current === undefined ? undefined : { '#version': 'version' },
        ExpressionAttributeValues:
          current === undefined ? undefined : { ':version': current.version },
      }),
    );
  }

  private async getItem(
    tableName: string,
    id: string,
  ): Promise<Record<string, unknown> | undefined> {
    const result = await this.client.send(new GetCommand({ TableName: tableName, Key: { id } }));
    return result.Item;
  }

  private async queryAll(input: QueryCommandInput): Promise<Record<string, unknown>[]> {
    const items: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;
    do {
      const response = await this.client.send(
        new QueryCommand({ ...input, ExclusiveStartKey: exclusiveStartKey }),
      );
      items.push(...(response.Items ?? []));
      exclusiveStartKey = response.LastEvaluatedKey;
    } while (exclusiveStartKey !== undefined);
    return items;
  }
}
