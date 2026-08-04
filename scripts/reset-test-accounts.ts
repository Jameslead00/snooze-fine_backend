import { execFileSync } from 'node:child_process';
import { DynamoDBClient, DescribeTableCommand, type KeySchemaElement } from '@aws-sdk/client-dynamodb';
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  ScanCommand,
  type DeleteCommandInput,
} from '@aws-sdk/lib-dynamodb';

const DEFAULT_REGION = 'eu-north-1';
const DEFAULT_USER_POOL_ID = 'eu-north-1_hmgn9tVBo';
const DEFAULT_TABLE_SUFFIX = '22zzo56n2vhdhezyn6ie6gihy4-NONE';
const CONFIRMATION = 'SNOOZEFINE_RESET_TEST_DATA';
const TARGET_EMAILS = ['swapseasedemo@gmail.com', 'james.leadbeater1@icloud.com'];

const tablePrefixes = [
  'AccountDeletionRequest', 'DisciPointAccount', 'DisciPointEarnEvent', 'EngagementEvent',
  'FriendConnection', 'FriendRequest', 'HabitDefinition', 'HabitOccurrence',
  'HabitProgressEvent', 'RevenueCatCustomerLink', 'RevenueCatWebhookEvent',
  'SubscriptionState', 'SyncedAlarm', 'UserProfile', 'UsernameReservation', 'WakeCompletion',
] as const;

type CognitoUser = { Username: string; Attributes?: Array<{ Name?: string; Value?: string }> };

const arg = (name: string): string | undefined => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

const region = arg('--region') ?? DEFAULT_REGION;
const userPoolId = arg('--user-pool-id') ?? DEFAULT_USER_POOL_ID;
const tableSuffix = arg('--table-suffix') ?? DEFAULT_TABLE_SUFFIX;
const profile = arg('--profile');
if (profile !== undefined) process.env.AWS_PROFILE = profile;

const aws = (arguments_: string[]): string =>
  execFileSync('aws', [...(profile === undefined ? [] : ['--profile', profile]), ...arguments_], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'inherit'],
  });

const emailFor = (user: CognitoUser): string | undefined =>
  user.Attributes?.find((attribute) => attribute.Name === 'email')?.Value;

const listUsers = (): CognitoUser[] => {
  const output = JSON.parse(aws([
    'cognito-idp', 'list-users', '--region', region, '--user-pool-id', userPoolId, '--output', 'json',
  ])) as { Users?: CognitoUser[] };
  return output.Users ?? [];
};

const hasTargetValue = (value: unknown, targetIds: ReadonlySet<string>): boolean => {
  if (typeof value === 'string') {
    return targetIds.has(value) || [...targetIds].some((id) => value.startsWith(`${id}:`));
  }
  if (Array.isArray(value)) return value.some((item) => hasTargetValue(item, targetIds));
  if (value !== null && typeof value === 'object') {
    return Object.values(value).some((item) => hasTargetValue(item, targetIds));
  }
  return false;
};

if (arg('--confirm') !== CONFIRMATION) {
  console.error(`Refusing to run. Add --confirm ${CONFIRMATION} to authorize the destructive reset.`);
  process.exit(1);
}

const targetEmails = new Set(TARGET_EMAILS);
const targetUsers = listUsers().filter((user) => {
  const email = emailFor(user);
  return email !== undefined && targetEmails.has(email.toLowerCase());
});
if (targetUsers.length !== TARGET_EMAILS.length) {
  const found = targetUsers.map((user) => emailFor(user) ?? user.Username).join(', ');
  throw new Error(`Expected both target accounts, found ${targetUsers.length}: ${found}`);
}

const targetIds = new Set(
  targetUsers.map((user) => user.Attributes?.find((attribute) => attribute.Name === 'sub')?.Value ?? user.Username),
);
const tables = tablePrefixes.map((prefix) => `${prefix}-${tableSuffix}`);
const client = DynamoDBDocumentClient.from(new DynamoDBClient({ region }), {
  marshallOptions: { removeUndefinedValues: true },
});

const tableKeys = async (tableName: string): Promise<string[]> => {
  const result = await client.send(new DescribeTableCommand({ TableName: tableName }));
  return (result.Table?.KeySchema ?? [])
    .map((key: KeySchemaElement) => key.AttributeName)
    .filter((key): key is string => key !== undefined);
};

const deleteMatchingItems = async (tableName: string): Promise<number> => {
  const keys = await tableKeys(tableName);
  let deleted = 0;
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: tableName, ExclusiveStartKey }));
    const requests: DeleteCommandInput[] = (page.Items ?? [])
      .filter((item) => hasTargetValue(item, targetIds))
      .map((item) => ({
        TableName: tableName,
        Key: Object.fromEntries(keys.map((key) => [key, item[key]])),
      }));
    for (let index = 0; index < requests.length; index += 25) {
      await Promise.all(requests.slice(index, index + 25).map((request) => client.send(new DeleteCommand(request))));
    }
    deleted += requests.length;
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey !== undefined);
  return deleted;
};

console.log(`Resetting ${targetUsers.length} Cognito users in ${userPoolId}`);
for (const user of targetUsers) console.log(`  ${emailFor(user) ?? user.Username} (${user.Username})`);
console.log(`Purging ${tables.length} SnoozeFine tables in ${region}`);

let deletedRecords = 0;
for (const table of tables) {
  const deleted = await deleteMatchingItems(table);
  deletedRecords += deleted;
  console.log(`  ${table}: deleted ${deleted}`);
}

for (const user of targetUsers) {
  aws(['cognito-idp', 'admin-delete-user', '--region', region, '--user-pool-id', userPoolId, '--username', user.Username]);
}

const remainingUsers = listUsers().filter((user) => {
  const email = emailFor(user);
  return email !== undefined && targetEmails.has(email.toLowerCase());
});
if (remainingUsers.length > 0) throw new Error('Verification failed: target Cognito users still exist');

for (const table of tables) {
  let ExclusiveStartKey: Record<string, unknown> | undefined;
  do {
    const page = await client.send(new ScanCommand({ TableName: table, ExclusiveStartKey }));
    if ((page.Items ?? []).some((item) => hasTargetValue(item, targetIds))) {
      throw new Error(`Verification failed: linked records remain in ${table}`);
    }
    ExclusiveStartKey = page.LastEvaluatedKey;
  } while (ExclusiveStartKey !== undefined);
}

console.log(`Reset complete. Deleted ${deletedRecords} linked DynamoDB records and ${targetUsers.length} Cognito users.`);
console.log('RevenueCat customer history outside AWS is unchanged; new Cognito users will receive new App User IDs.');
