import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type ScanCommandInput,
} from '@aws-sdk/lib-dynamodb';
import { PLATFORM_CONFIG } from '../amplify/shared/config.js';
import { DynamoPlatformRepository } from '../amplify/shared/dynamo-repository.js';
import { runSettlement } from '../amplify/shared/domain.js';
import { expectedDonationMicroUsd, formatMicroUsd } from '../amplify/shared/money.js';
import { sha256 } from '../amplify/shared/security.js';
import { summarizeEngagement } from './engagement-summary.js';
import {
  loadPlatformOutputs,
  monthCutoff,
  parseOptions,
  requestedEnvironment,
  stringOption,
} from './shared.js';

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

async function scanAll(input: ScanCommandInput): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new ScanCommand({ ...input, ExclusiveStartKey: key }),
    );
    items.push(...(response.Items ?? []));
    key = response.LastEvaluatedKey;
  } while (key !== undefined);
  return items;
}

async function summary(environment: 'SANDBOX' | 'PRODUCTION'): Promise<void> {
  const { tables } = await loadPlatformOutputs();
  const [profiles, subscriptions, accounts, webhooks, settlements] = await Promise.all([
    scanAll({ TableName: tables.userProfile, ProjectionExpression: 'id' }),
    scanAll({
      TableName: tables.subscription,
      FilterExpression: '#environment = :environment',
      ExpressionAttributeNames: { '#environment': 'environment' },
      ExpressionAttributeValues: { ':environment': environment },
    }),
    scanAll({
      TableName: tables.account,
      FilterExpression: '#environment = :environment',
      ExpressionAttributeNames: { '#environment': 'environment' },
      ExpressionAttributeValues: { ':environment': environment },
    }),
    scanAll({
      TableName: tables.webhook,
      FilterExpression: '#environment = :environment AND #status = :status',
      ExpressionAttributeNames: { '#environment': 'environment', '#status': 'status' },
      ExpressionAttributeValues: { ':environment': environment, ':status': 'UNRESOLVED' },
      ProjectionExpression: 'id',
    }),
    scanAll({
      TableName: tables.settlement,
      FilterExpression: '#environment = :environment AND #status = :status',
      ExpressionAttributeNames: { '#environment': 'environment', '#status': 'status' },
      ExpressionAttributeValues: { ':environment': environment, ':status': 'CALCULATED' },
    }),
  ]);
  const now = new Date().toISOString();
  const activeStatuses = new Set([
    'ACTIVE',
    'GRACE_PERIOD',
    'BILLING_ISSUE',
    'CANCELLED_PENDING_EXPIRY',
  ]);
  const activeSubscribers = subscriptions.filter(
    (item) =>
      activeStatuses.has(String(item.status)) &&
      typeof item.currentPeriodEnd === 'string' &&
      item.currentPeriodEnd > now,
  ).length;
  const remainingPoints = accounts.reduce(
    (total, item) => total + Math.max(0, Number(item.currentBalance)),
    0,
  );
  const expectedMicroUsd = expectedDonationMicroUsd(
    remainingPoints,
    PLATFORM_CONFIG.microUsdPerPoint,
  );
  const latestSettlement = settlements.sort((a, b) =>
    String(b.calendarMonth).localeCompare(String(a.calendarMonth)),
  )[0];

  console.log('SnoozeFine admin summary');
  console.log(`Environment: ${environment}`);
  console.log(`Settlement mode: ${PLATFORM_CONFIG.settlementMode}`);
  console.log(`Total users: ${profiles.length}`);
  console.log(`Active subscribers: ${activeSubscribers}`);
  console.log(`Total current remaining DisciPoints: ${remainingPoints}`);
  console.log(`Donation rate: ${PLATFORM_CONFIG.microUsdPerPoint} micro-USD/point`);
  console.log(`Expected donation: ${formatMicroUsd(expectedMicroUsd)}`);
  console.log(`Unresolved RevenueCat events: ${webhooks.length}`);
  console.log(
    `Last calculated monthly settlement: ${
      latestSettlement === undefined
        ? 'none'
        : `${String(latestSettlement.calendarMonth)} (${String(
            latestSettlement.expectedDonationDisplay,
          )})`
    }`,
  );
  console.log('TEST MODE — EXPECTED DONATION ONLY — NO DONATION HAS BEEN PAID');
}

async function unresolvedWebhooks(environment: 'SANDBOX' | 'PRODUCTION'): Promise<void> {
  const { tables } = await loadPlatformOutputs();
  const events = await scanAll({
    TableName: tables.webhook,
    FilterExpression: '#environment = :environment AND #status = :status',
    ExpressionAttributeNames: { '#environment': 'environment', '#status': 'status' },
    ExpressionAttributeValues: { ':environment': environment, ':status': 'UNRESOLVED' },
    ProjectionExpression:
      'id, eventType, appUserId, originalAppUserId, aliases, transferredFrom, transferredTo, receivedAt, processingError',
  });
  events
    .sort((a, b) => String(b.receivedAt).localeCompare(String(a.receivedAt)))
    .forEach((event) => console.log(JSON.stringify(event)));
  console.log(`Unresolved ${environment} events: ${events.length}`);
}

async function engagement(
  environment: 'SANDBOX' | 'PRODUCTION',
  options: ReturnType<typeof parseOptions>,
): Promise<void> {
  const rawDays = stringOption(options, 'days', '30');
  const days = Number(rawDays);
  if (!Number.isInteger(days) || days < 1 || days > 365) {
    throw new Error('--days must be an integer from 1 to 365');
  }
  const since = new Date(Date.now() - days * 24 * 60 * 60 * 1_000).toISOString();
  const { tables } = await loadPlatformOutputs();
  const events = await scanAll({
    TableName: tables.engagement,
    FilterExpression: '#environment = :environment AND receivedAt >= :since',
    ExpressionAttributeNames: { '#environment': 'environment', '#name': 'name' },
    ExpressionAttributeValues: { ':environment': environment, ':since': since },
    ProjectionExpression: 'userId, environment, sessionId, #name, receivedAt',
  });
  console.log(JSON.stringify(summarizeEngagement(events, environment, since), null, 2));
}

async function settlement(
  environment: 'SANDBOX' | 'PRODUCTION',
  month: string | undefined,
): Promise<void> {
  if (month === undefined) throw new Error('settlement requires --month YYYY-MM');
  const cutoff = monthCutoff(month);
  const { tables } = await loadPlatformOutputs();
  const repository = new DynamoPlatformRepository(tables, environment, documentClient);
  const result = await runSettlement(repository, month, environment, cutoff);
  console.log(
    JSON.stringify(
      {
        month,
        environment,
        mode: 'TEST',
        duplicate: result.duplicate,
        ...result.calculation,
        expectedDonation: formatMicroUsd(result.calculation.expectedDonationMicroUsd),
        warning: 'TEST SETTLEMENT — EXPECTED DONATION ONLY — NOT YET PAID',
      },
      null,
      2,
    ),
  );
}

async function adjust(
  environment: 'SANDBOX' | 'PRODUCTION',
  options: ReturnType<typeof parseOptions>,
): Promise<void> {
  if (environment === 'PRODUCTION' && options['confirm-production'] !== true) {
    throw new Error('Production adjustment requires --confirm-production');
  }
  const userId = stringOption(options, 'user-id');
  const rawAmount = stringOption(options, 'amount');
  const reason = stringOption(options, 'reason');
  const idempotencyKey = stringOption(options, 'idempotency-key');
  if (
    userId === undefined ||
    rawAmount === undefined ||
    reason === undefined ||
    idempotencyKey === undefined
  ) {
    throw new Error('adjust requires --user-id, --amount, --reason, and --idempotency-key');
  }
  const requestedAmount = Number(rawAmount);
  if (!Number.isSafeInteger(requestedAmount) || requestedAmount === 0) {
    throw new Error('--amount must be a non-zero signed integer');
  }
  if (reason.length < 3 || reason.length > 200) {
    throw new Error('--reason must contain 3–200 characters');
  }
  const { tables } = await loadPlatformOutputs();
  const transactionId = sha256(`admin-adjustment:${idempotencyKey}`);
  const existing = await documentClient.send(
    new GetCommand({
      TableName: tables.transaction,
      Key: { id: transactionId },
      ConsistentRead: true,
    }),
  );
  if (existing.Item !== undefined) {
    console.log(
      JSON.stringify({
        duplicate: true,
        transactionId,
        officialBalance: Number(existing.Item.balanceAfter),
      }),
    );
    return;
  }
  const accountId = `${userId}:${environment}`;
  const accountResponse = await documentClient.send(
    new GetCommand({
      TableName: tables.account,
      Key: { id: accountId },
      ConsistentRead: true,
    }),
  );
  const account = accountResponse.Item;
  if (account === undefined || typeof account.activePeriodId !== 'string') {
    throw new Error('No active point account was found for that user and environment');
  }
  const periodResponse = await documentClient.send(
    new GetCommand({
      TableName: tables.period,
      Key: { id: account.activePeriodId },
      ConsistentRead: true,
    }),
  );
  const period = periodResponse.Item;
  if (period === undefined) throw new Error('The active point period is missing');
  const oldBalance = Number(account.currentBalance);
  const initialAllocation = Number(period.initialAllocation);
  const newBalance = Math.max(0, Math.min(initialAllocation, oldBalance + requestedAmount));
  const actualAmount = newBalance - oldBalance;
  const now = new Date().toISOString();
  await documentClient.send(
    new TransactWriteCommand({
      TransactItems: [
        {
          Put: {
            TableName: tables.transaction,
            Item: {
              id: transactionId,
              userId,
              environment,
              userEnvironment: `${userId}:${environment}`,
              pointPeriodId: account.activePeriodId,
              amount: actualAmount,
              transactionType: 'ADMIN_ADJUSTMENT',
              reasonCode: 'ADMIN_MANUAL_ADJUSTMENT',
              source: 'ADMIN',
              idempotencyKey: `admin-adjustment:${idempotencyKey}`,
              sourceEventId: idempotencyKey,
              balanceAfter: newBalance,
              createdAt: now,
              updatedAt: now,
              metadataJson: { requestedAmount, reason },
            },
            ConditionExpression: 'attribute_not_exists(id)',
          },
        },
        {
          Update: {
            TableName: tables.account,
            Key: { id: accountId },
            UpdateExpression:
              'SET currentBalance = :newBalance, version = version + :one, updatedAt = :now',
            ConditionExpression:
              'version = :version AND currentBalance = :oldBalance AND activePeriodId = :periodId',
            ExpressionAttributeValues: {
              ':newBalance': newBalance,
              ':one': 1,
              ':now': now,
              ':version': Number(account.version),
              ':oldBalance': oldBalance,
              ':periodId': account.activePeriodId,
            },
          },
        },
        {
          Update: {
            TableName: tables.period,
            Key: { id: account.activePeriodId },
            UpdateExpression: 'SET currentRemaining = :newBalance, updatedAt = :now',
            ConditionExpression: 'currentRemaining = :oldBalance AND userId = :userId',
            ExpressionAttributeValues: {
              ':newBalance': newBalance,
              ':now': now,
              ':oldBalance': oldBalance,
              ':userId': userId,
            },
          },
        },
      ],
    }),
  );
  console.log(
    JSON.stringify(
      {
        duplicate: false,
        transactionId,
        requestedAmount,
        actualAmount,
        officialBalance: newBalance,
        environment,
      },
      null,
      2,
    ),
  );
}

async function ledger(
  environment: 'SANDBOX' | 'PRODUCTION',
  userId: string | undefined,
): Promise<void> {
  if (userId === undefined) throw new Error('ledger requires --user-id <cognito-sub>');
  const { tables } = await loadPlatformOutputs();
  const accountId = `${userId}:${environment}`;
  const account = (
    await documentClient.send(
      new GetCommand({
        TableName: tables.account,
        Key: { id: accountId },
        ConsistentRead: true,
      }),
    )
  ).Item;
  const transactions: Record<string, unknown>[] = [];
  let key: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: tables.transaction,
        IndexName: 'byUserEnvironmentAndCreatedAt',
        KeyConditionExpression: 'userEnvironment = :key',
        ExpressionAttributeValues: { ':key': `${userId}:${environment}` },
        ScanIndexForward: false,
        ExclusiveStartKey: key,
      }),
    );
    transactions.push(...(response.Items ?? []));
    key = response.LastEvaluatedKey;
  } while (key !== undefined);
  const activePeriodId =
    account !== undefined && typeof account.activePeriodId === 'string'
      ? account.activePeriodId
      : undefined;
  const activePeriodLedgerTotal = transactions
    .filter((transaction) => transaction.pointPeriodId === activePeriodId)
    .reduce((total, transaction) => total + Number(transaction.amount), 0);
  console.log(
    JSON.stringify(
      {
        userId,
        environment,
        account,
        activePeriodLedgerTotal,
        projectionMatchesActivePeriod:
          account !== undefined &&
          activePeriodId !== undefined &&
          activePeriodLedgerTotal === Number(account.currentBalance),
        transactions,
      },
      null,
      2,
    ),
  );
}

async function main(): Promise<void> {
  const [command, ...rawOptions] = process.argv.slice(2);
  const options = parseOptions(rawOptions);
  const environment = requestedEnvironment(options);
  if (command === 'summary') await summary(environment);
  else if (command === 'unresolved-webhooks') await unresolvedWebhooks(environment);
  else if (command === 'engagement') await engagement(environment, options);
  else if (command === 'settlement') {
    await settlement(environment, stringOption(options, 'month'));
  } else if (command === 'adjust') {
    await adjust(environment, options);
  } else if (command === 'ledger') {
    await ledger(environment, stringOption(options, 'user-id'));
  } else {
    throw new Error(
      'Usage: admin.ts <summary|unresolved-webhooks|engagement|settlement|adjust|ledger> [options]',
    );
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Admin command failed');
  process.exitCode = 1;
});
