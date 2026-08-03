import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from '@aws-sdk/lib-dynamodb';
import { PLATFORM_CONFIG } from '../amplify/shared/config.js';
import { localParts } from '../amplify/shared/habits.js';
import { formatMicroUsd } from '../amplify/shared/money.js';
import { sha256 } from '../amplify/shared/security.js';
import {
  loadPlatformOutputs,
  parseOptions,
  requestedEnvironment,
  stringOption,
} from './shared.js';

const documentClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const charityDefinitions = [
  {
    id: 'staging-fixture-charity-meals',
    name: "Mary's Meals",
    summary: 'School meals for children around the world.',
    impactLabel: 'School meals',
    sortOrder: 1,
  },
  {
    id: 'staging-fixture-charity-ocean',
    name: 'The Ocean Cleanup',
    summary: 'Cleaner oceans for generations to come.',
    impactLabel: 'Cleaner oceans',
    sortOrder: 2,
  },
  {
    id: 'staging-fixture-charity-mental-health',
    name: 'Mental Health Foundation',
    summary: 'Better mental wellbeing for everyone.',
    impactLabel: 'Mental wellbeing',
    sortOrder: 3,
  },
] as const;

const votePattern = [0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2];

function isConditionalFailure(error: unknown): boolean {
  return error instanceof Error && error.name === 'ConditionalCheckFailedException';
}

async function putIfMissing(tableName: string, item: Record<string, unknown>): Promise<boolean> {
  try {
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: item,
        ConditionExpression: 'attribute_not_exists(id)',
      }),
    );
    return true;
  } catch (error) {
    if (isConditionalFailure(error)) return false;
    throw error;
  }
}

async function queryAll(
  tableName: string,
  indexName: string,
  keyName: string,
  keyValue: string,
): Promise<Record<string, unknown>[]> {
  const items: Record<string, unknown>[] = [];
  let exclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const response = await documentClient.send(
      new QueryCommand({
        TableName: tableName,
        IndexName: indexName,
        KeyConditionExpression: `${keyName} = :value`,
        ExpressionAttributeValues: { ':value': keyValue },
        ExclusiveStartKey: exclusiveStartKey,
      }),
    );
    items.push(...(response.Items ?? []));
    exclusiveStartKey = response.LastEvaluatedKey;
  } while (exclusiveStartKey !== undefined);
  return items;
}

function countOption(options: Record<string, string | boolean>, name: string, fallback: number): number {
  const value = Number(stringOption(options, name, String(fallback)));
  if (!Number.isSafeInteger(value) || value < 1 || value > 100) {
    throw new Error(`--${name} must be an integer from 1 to 100`);
  }
  return value;
}

function monthBounds(month: string): { start: Date; end: Date } {
  const match = /^(\d{4})-(0[1-9]|1[0-2])$/.exec(month);
  if (match === null) throw new Error('--month must use YYYY-MM');
  const year = Number(match[1]);
  const monthIndex = Number(match[2]) - 1;
  return {
    start: new Date(Date.UTC(year, monthIndex, 1)),
    end: new Date(Date.UTC(year, monthIndex + 1, 1)),
  };
}

function requiredTable(
  tables: Awaited<ReturnType<typeof loadPlatformOutputs>>['tables'],
  key: 'charity' | 'ballot' | 'vote',
): string {
  const value = tables[key];
  if (value === undefined) {
    throw new Error(
      `Backend-only table mapping is missing ${key}. Add the community table names to SNOOZEFINE_ADMIN_TABLES_PATH.`,
    );
  }
  return value;
}

function recentLocalDates(now: string, month: string, timezone: string, requestedDays: number): string[] {
  const dates = new Set<string>();
  const nowMs = Date.parse(now);
  for (let offset = 0; offset < 31 && dates.size < requestedDays; offset += 1) {
    const date = localParts(new Date(nowMs - offset * 24 * 60 * 60 * 1_000).toISOString(), timezone).date;
    if (date.startsWith(`${month}-`)) dates.add(date);
  }
  const result = [...dates].sort();
  if (result.length === 0) throw new Error('No vote dates are available in the requested month');
  return result;
}

async function seedCharities(tableName: string, now: string): Promise<string[]> {
  for (const charity of charityDefinitions) {
    await documentClient.send(
      new PutCommand({
        TableName: tableName,
        Item: {
          ...charity,
          active: true,
          activeState: 'ACTIVE',
          updatedAt: now,
        },
      }),
    );
  }
  return charityDefinitions.map((charity) => charity.id);
}

async function seedBallot(
  tableName: string,
  month: string,
  charityIds: string[],
  opensAt: string,
  closesAt: string,
  now: string,
): Promise<string> {
  const ballotId = `staging-fixture-ballot-${month}`;
  const existing = (
    await documentClient.send(new GetCommand({ TableName: tableName, Key: { id: ballotId } }))
  ).Item;
  if (existing?.environment === 'PRODUCTION') {
    throw new Error(`Refusing to use production ballot ${ballotId}`);
  }
  if (existing?.status === 'CLOSED') {
    throw new Error(`Fixture ballot ${ballotId} is already closed; choose a new staging month`);
  }

  const existingTallies =
    typeof existing?.tallies === 'object' && existing.tallies !== null
      ? (existing.tallies as Record<string, number>)
      : Object.fromEntries(charityIds.map((charityId) => [charityId, 0]));
  await documentClient.send(
    new PutCommand({
      TableName: tableName,
      Item: {
        ...existing,
        id: ballotId,
        month,
        environment: 'SANDBOX',
        environmentStatus: 'SANDBOX:OPEN',
        status: 'OPEN',
        opensAt,
        closesAt,
        charityIds,
        tallies: existingTallies,
        totalVotes: Number(existing?.totalVotes ?? 0),
        version: Number(existing?.version ?? 1),
        updatedAt: now,
      },
    }),
  );
  return ballotId;
}

async function seedMember(
  tables: Awaited<ReturnType<typeof loadPlatformOutputs>>['tables'],
  memberIndex: number,
  month: string,
  start: string,
  end: string,
  now: string,
): Promise<number> {
  const memberNumber = (memberIndex + 1).toString().padStart(2, '0');
  const userId = `staging-fixture-member-${memberNumber}`;
  const periodId = `staging-fixture-period-${month}-${memberNumber}`;
  const subscriptionId = `${userId}:${PLATFORM_CONFIG.entitlementId}:SANDBOX`;
  const accountId = `${userId}:SANDBOX`;
  const allocationTransactionId = `staging-fixture-allocation-${month}-${memberNumber}`;
  const deductions = (memberIndex % 5) + 1;
  const currentRemaining = PLATFORM_CONFIG.monthlyPointAllocation - deductions * 25;

  await putIfMissing(tables.subscription, {
    id: subscriptionId,
    userId,
    revenueCatAppUserId: `${userId}:revenuecat`,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId: PLATFORM_CONFIG.monthlyProductId,
    status: 'ACTIVE',
    environment: 'SANDBOX',
    originalPurchaseAt: start,
    currentPeriodStart: start,
    currentPeriodEnd: end,
    autoRenew: true,
    lastRevenueCatEventId: `staging-fixture-subscription-${month}-${memberNumber}`,
    stateEventAt: now,
    statusEffectiveAt: now,
    updatedAt: now,
  });
  await putIfMissing(tables.period, {
    id: periodId,
    userId,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId: PLATFORM_CONFIG.monthlyProductId,
    periodStart: start,
    periodEnd: end,
    environment: 'SANDBOX',
    initialAllocation: PLATFORM_CONFIG.monthlyPointAllocation,
    currentRemaining,
    status: 'ACTIVE',
    allocationTransactionId,
    createdAt: start,
    updatedAt: now,
  });
  await putIfMissing(tables.account, {
    id: accountId,
    userId,
    environment: 'SANDBOX',
    currentBalance: currentRemaining,
    activePeriodId: periodId,
    lifetimeAllocated: PLATFORM_CONFIG.monthlyPointAllocation,
    lifetimeDeducted: deductions * 25,
    version: deductions + 1,
    updatedAt: now,
  });
  await putIfMissing(tables.transaction, {
    id: allocationTransactionId,
    userId,
    environment: 'SANDBOX',
    userEnvironment: `${userId}:SANDBOX`,
    pointPeriodId: periodId,
    amount: PLATFORM_CONFIG.monthlyPointAllocation,
    transactionType: 'MONTHLY_ALLOCATION',
    reasonCode: 'STAGING_FIXTURE_ALLOCATION',
    source: 'REVENUECAT_WEBHOOK',
    idempotencyKey: `subscription-allocation:${userId}:${month}:staging-fixture`,
    sourceEventId: `staging-fixture-subscription-${month}-${memberNumber}`,
    balanceAfter: PLATFORM_CONFIG.monthlyPointAllocation,
    createdAt: start,
    metadataJson: JSON.stringify({ fixture: 'staging-community' }),
  });
  for (let deductionIndex = 1; deductionIndex <= deductions; deductionIndex += 1) {
    const deductionId = `staging-fixture-deduction-${month}-${memberNumber}-${deductionIndex}`;
    await putIfMissing(tables.transaction, {
      id: deductionId,
      userId,
      environment: 'SANDBOX',
      userEnvironment: `${userId}:SANDBOX`,
      pointPeriodId: periodId,
      amount: -25,
      transactionType: 'SNOOZE_DEDUCTION',
      reasonCode: 'STAGING_FIXTURE_SNOOZE',
      source: 'IOS_APP',
      idempotencyKey: `staging-fixture:snooze:${month}:${memberNumber}:${deductionIndex}`,
      sourceEventId: `staging-fixture-snooze-${month}-${memberNumber}-${deductionIndex}`,
      balanceAfter: PLATFORM_CONFIG.monthlyPointAllocation - deductionIndex * 25,
      createdAt: now,
      metadataJson: JSON.stringify({ fixture: 'staging-community' }),
    });
  }
  return currentRemaining;
}

async function seedVotes(
  tableName: string,
  ballotId: string,
  charityIds: string[],
  memberCount: number,
  dates: string[],
  timezone: string,
  now: string,
): Promise<number> {
  let added = 0;
  for (let dateIndex = 0; dateIndex < dates.length; dateIndex += 1) {
    const localVoteDate = dates[dateIndex];
    if (localVoteDate === undefined) continue;
    for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
      const memberNumber = (memberIndex + 1).toString().padStart(2, '0');
      const userId = `staging-fixture-member-${memberNumber}`;
      const patternIndex = (memberIndex + dateIndex * 3) % votePattern.length;
      const charityId = charityIds[votePattern[patternIndex] ?? 0];
      if (charityId === undefined) throw new Error('Vote pattern references an unknown charity');
      const voteId = sha256(`daily-vote:${userId}:${ballotId}:${localVoteDate}`);
      const createdAt = new Date(
        Date.parse(now) - (dates.length - dateIndex - 1) * 24 * 60 * 60 * 1_000,
      ).toISOString();
      if (
        await putIfMissing(tableName, {
          id: voteId,
          userId,
          environment: 'SANDBOX',
          ballotId,
          charityId,
          localVoteDate,
          timezone,
          createdAt,
        })
      ) {
        added += 1;
      }
    }
  }
  return added;
}

async function recalculateBallot(
  tableName: string,
  ballotId: string,
  charityIds: string[],
  now: string,
): Promise<{ totalVotes: number; tallies: Record<string, number> }> {
  const votes = await queryAll(tableName, 'byBallotAndCreatedAt', 'ballotId', ballotId);
  const tallies = Object.fromEntries(charityIds.map((charityId) => [charityId, 0]));
  for (const vote of votes) {
    const charityId = typeof vote.charityId === 'string' ? vote.charityId : undefined;
    if (charityId !== undefined && tallies[charityId] !== undefined) tallies[charityId] += 1;
  }
  const current = (
    await documentClient.send(new GetCommand({ TableName: tableName, Key: { id: ballotId } }))
  ).Item;
  await documentClient.send(
    new UpdateCommand({
      TableName: tableName,
      Key: { id: ballotId },
      UpdateExpression: 'SET tallies = :tallies, totalVotes = :totalVotes, #version = :version, updatedAt = :now',
      ExpressionAttributeNames: { '#version': 'version' },
      ExpressionAttributeValues: {
        ':tallies': tallies,
        ':totalVotes': votes.length,
        ':version': Number(current?.version ?? 1) + 1,
        ':now': now,
      },
    }),
  );
  return { totalVotes: votes.length, tallies };
}

async function main(): Promise<void> {
  const options = parseOptions(process.argv.slice(2));
  if (options.staging !== true) {
    throw new Error('This fixture is staging-only. Re-run with --staging.');
  }
  const environment = requestedEnvironment(options);
  if (environment !== 'SANDBOX') {
    throw new Error('Community fixture seeding is restricted to SANDBOX.');
  }
  const region = process.env.AWS_REGION ?? process.env.AWS_DEFAULT_REGION;
  if (region !== 'eu-north-1') {
    throw new Error('Staging fixture seeding requires AWS_REGION=eu-north-1.');
  }

  const timezone = stringOption(options, 'timezone', 'Europe/Zurich') ?? 'Europe/Zurich';
  const now = new Date().toISOString();
  const currentMonth = localParts(now, timezone).date.slice(0, 7);
  const month = stringOption(options, 'month', currentMonth) ?? currentMonth;
  if (month !== currentMonth) {
    throw new Error(`--month must be the current month (${currentMonth}) so the app can see the ballot.`);
  }
  const memberCount = countOption(options, 'members', 12);
  const voteDays = countOption(options, 'vote-days', 3);
  const dates = recentLocalDates(now, month, timezone, voteDays);
  const { start, end } = monthBounds(month);
  const outputs = await loadPlatformOutputs();
  const charityTable = requiredTable(outputs.tables, 'charity');
  const ballotTable = requiredTable(outputs.tables, 'ballot');
  const voteTable = requiredTable(outputs.tables, 'vote');
  const charityIds = await seedCharities(charityTable, now);
  const ballotId = await seedBallot(
    ballotTable,
    month,
    charityIds,
    start.toISOString(),
    end.toISOString(),
    now,
  );
  let remainingPoints = 0;
  for (let memberIndex = 0; memberIndex < memberCount; memberIndex += 1) {
    remainingPoints += await seedMember(
      outputs.tables,
      memberIndex,
      month,
      start.toISOString(),
      end.toISOString(),
      now,
    );
  }
  const votesAdded = await seedVotes(
    voteTable,
    ballotId,
    charityIds,
    memberCount,
    dates,
    timezone,
    now,
  );
  const ballot = await recalculateBallot(ballotTable, ballotId, charityIds, now);
  const expectedDonationMicroUsd = remainingPoints * PLATFORM_CONFIG.microUsdPerPoint;
  console.log(
    JSON.stringify(
      {
        fixture: 'staging-community',
        environment,
        month,
        ballotId,
        syntheticMemberCount: memberCount,
        voteDates: dates,
        votesAdded,
        totalVotes: ballot.totalVotes,
        tallies: ballot.tallies,
        remainingPoints,
        expectedDonationMicroUsd: String(expectedDonationMicroUsd),
        expectedDonation: formatMicroUsd(expectedDonationMicroUsd),
        warning: 'STAGING FIXTURE — SYNTHETIC MEMBERS — EXPECTED DONATION ONLY — NO DONATION HAS BEEN PAID',
      },
      null,
      2,
    ),
  );
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : 'Community fixture seeding failed');
  process.exitCode = 1;
});
