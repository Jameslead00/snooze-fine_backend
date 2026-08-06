import { defineBackend } from '@aws-amplify/backend';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import {
  AttributeType,
  BillingMode,
  Table,
  TableEncryption,
  type ITable,
} from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Duration, RemovalPolicy } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { accountApiFunction } from './functions/account-api/resource.js';
import { habitApiFunction } from './functions/habit-api/resource.js';
import { habitEnforcerFunction } from './functions/habit-enforcer/resource.js';
import { linkRevenueCatCustomerFunction } from './functions/link-revenuecat-customer/resource.js';
import { requestAccountDeletionFunction } from './functions/request-account-deletion/resource.js';
import { processAccountDeletionFunction } from './functions/process-account-deletion/resource.js';
import { revenueCatWebhook } from './functions/revenuecat-webhook/resource.js';
import { awardEnvironmentDefaults, socialEnvironmentDefaults } from './shared/config.js';

const backend = defineBackend({
  auth,
  data,
  accountApiFunction,
  habitApiFunction,
  habitEnforcerFunction,
  linkRevenueCatCustomerFunction,
  requestAccountDeletionFunction,
  processAccountDeletionFunction,
  revenueCatWebhook,
});

// Cognito treats required user-pool attributes as immutable. Amplify's generated template
// includes a one-item email schema, while an existing pool also has Cognito's complete set of
// standard attributes. Re-sending that partial Schema during an in-place update makes Cognito
// interpret the request as a required-attribute change and fail with
// "Required custom attributes are not supported currently." Keep the deployed schema intact.
const cfnUserPool = backend.auth.resources.cfnResources.cfnUserPool;
cfnUserPool.addPropertyDeletionOverride('Schema');

const tables = backend.data.resources.tables;
const requireTable = (name: string) => {
  const table = tables[name];
  if (table === undefined) throw new Error(`Expected Amplify Data table ${name}`);
  return table;
};
const platformTables = {
  userProfile: requireTable('UserProfile'),
  customerLink: requireTable('RevenueCatCustomerLink'),
  webhook: requireTable('RevenueCatWebhookEvent'),
  subscription: requireTable('SubscriptionState'),
  earnedPointAccount: requireTable('DisciPointAccount'),
  earnedPointEvent: requireTable('DisciPointEarnEvent'),
  syncedAlarm: requireTable('SyncedAlarm'),
  wakeCompletion: requireTable('WakeCompletion'),
  engagementEvent: requireTable('EngagementEvent'),
  habit: requireTable('HabitDefinition'),
  habitOccurrence: requireTable('HabitOccurrence'),
  habitProgressEvent: requireTable('HabitProgressEvent'),
  usernameReservation: requireTable('UsernameReservation'),
  friendRequest: requireTable('FriendRequest'),
  friendConnection: requireTable('FriendConnection'),
  accountDeletionRequest: requireTable('AccountDeletionRequest'),
};
const functions = {
  account: backend.accountApiFunction,
  habit: backend.habitApiFunction,
  habitEnforcer: backend.habitEnforcerFunction,
  link: backend.linkRevenueCatCustomerFunction,
  deletion: backend.requestAccountDeletionFunction,
  deletionProcessor: backend.processAccountDeletionFunction,
  webhook: backend.revenueCatWebhook,
};

const rateLimitStack = backend.createStack('rate-limits');
const rateLimitTable = new Table(rateLimitStack, 'RateLimitTable', {
  partitionKey: { name: 'bucketKey', type: AttributeType.STRING },
  billingMode: BillingMode.PAY_PER_REQUEST,
  encryption: TableEncryption.AWS_MANAGED,
  timeToLiveAttribute: 'expiresAt',
  removalPolicy: RemovalPolicy.RETAIN,
});

for (const target of [functions.account, functions.habit, functions.link, functions.deletion]) {
  rateLimitTable.grantReadWriteData(target.resources.lambda);
  target.addEnvironment('RATE_LIMIT_TABLE_NAME', rateLimitTable.tableName);
}

function addTableEnvironment(
  target: (typeof functions)[keyof typeof functions],
  variableName: string,
  tableName: string,
): void {
  target.addEnvironment(variableName, tableName);
}

const allTableEnvironment: Array<[string, ITable]> = [
  ['USER_PROFILE_TABLE_NAME', platformTables.userProfile],
  ['CUSTOMER_LINK_TABLE_NAME', platformTables.customerLink],
  ['WEBHOOK_TABLE_NAME', platformTables.webhook],
  ['SUBSCRIPTION_TABLE_NAME', platformTables.subscription],
  ['DISCIPOINT_ACCOUNT_TABLE_NAME', platformTables.earnedPointAccount],
  ['DISCIPOINT_EARN_EVENT_TABLE_NAME', platformTables.earnedPointEvent],
  ['SYNCED_ALARM_TABLE_NAME', platformTables.syncedAlarm],
  ['WAKE_COMPLETION_TABLE_NAME', platformTables.wakeCompletion],
  ['ENGAGEMENT_EVENT_TABLE_NAME', platformTables.engagementEvent],
  ['USERNAME_RESERVATION_TABLE_NAME', platformTables.usernameReservation],
  ['FRIEND_REQUEST_TABLE_NAME', platformTables.friendRequest],
  ['FRIEND_CONNECTION_TABLE_NAME', platformTables.friendConnection],
];

for (const target of Object.values(functions)) {
  for (const [variableName, table] of allTableEnvironment) {
    addTableEnvironment(target, variableName, table.tableName);
  }
}

for (const [name, value] of Object.entries({
  ...awardEnvironmentDefaults(),
  ...socialEnvironmentDefaults(),
})) {
  const configuredValue = process.env[name] ?? value;
  functions.account.addEnvironment(name, configuredValue);
  functions.habit.addEnvironment(name, configuredValue);
}

functions.account.addEnvironment(
  'SNOOZEFINE_ALLOW_TESTFLIGHT_SANDBOX_SUBSCRIPTIONS',
  process.env.SNOOZEFINE_ALLOW_TESTFLIGHT_SANDBOX_SUBSCRIPTIONS === 'true' ? 'true' : 'false',
);

const habitTableEnvironment: Array<[string, ITable]> = [
  ['HABIT_DEFINITION_TABLE_NAME', platformTables.habit],
  ['HABIT_OCCURRENCE_TABLE_NAME', platformTables.habitOccurrence],
  ['HABIT_PROGRESS_EVENT_TABLE_NAME', platformTables.habitProgressEvent],
];
for (const target of [functions.habit, functions.habitEnforcer, functions.account]) {
  for (const [variableName, table] of habitTableEnvironment) {
    addTableEnvironment(target, variableName, table.tableName);
  }
}

functions.deletionProcessor.addEnvironment(
  'ACCOUNT_DELETION_REQUEST_TABLE_NAME',
  platformTables.accountDeletionRequest.tableName,
);

platformTables.customerLink.grantReadData(functions.webhook.resources.lambda);
platformTables.webhook.grantReadWriteData(functions.webhook.resources.lambda);
platformTables.subscription.grantReadWriteData(functions.webhook.resources.lambda);

platformTables.userProfile.grantReadWriteData(functions.link.resources.lambda);
platformTables.customerLink.grantReadWriteData(functions.link.resources.lambda);

platformTables.subscription.grantReadData(functions.account.resources.lambda);
// The entitlement lookup uses the secondary index; grant its ARN explicitly.
functions.account.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${platformTables.subscription.tableArn}/index/byUserAndEnvironment`],
  }),
);
// Account API owns username setup as well as social-profile reads. Username
// reservation is atomic, but the companion profile write must be authorized.
platformTables.userProfile.grantReadWriteData(functions.account.resources.lambda);
platformTables.earnedPointAccount.grantReadWriteData(functions.account.resources.lambda);
platformTables.earnedPointEvent.grantReadWriteData(functions.account.resources.lambda);
platformTables.syncedAlarm.grantReadWriteData(functions.account.resources.lambda);
platformTables.wakeCompletion.grantReadWriteData(functions.account.resources.lambda);
platformTables.engagementEvent.grantReadWriteData(functions.account.resources.lambda);
platformTables.usernameReservation.grantReadWriteData(functions.account.resources.lambda);
platformTables.friendRequest.grantReadWriteData(functions.account.resources.lambda);
platformTables.friendConnection.grantReadWriteData(functions.account.resources.lambda);
platformTables.habit.grantReadData(functions.account.resources.lambda);
platformTables.habitOccurrence.grantReadData(functions.account.resources.lambda);
functions.account.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [
      `${platformTables.earnedPointEvent.tableArn}/index/byUserEnvironmentAndCreatedAt`,
      `${platformTables.syncedAlarm.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
      `${platformTables.wakeCompletion.tableArn}/index/byUserEnvironmentAndCompletedAt`,
      `${platformTables.friendRequest.tableArn}/index/byRequesterEnvironmentAndUpdatedAt`,
      `${platformTables.friendRequest.tableArn}/index/byRecipientEnvironmentAndUpdatedAt`,
      `${platformTables.friendConnection.tableArn}/index/byUserEnvironmentAndCreatedAt`,
      `${platformTables.habit.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
      `${platformTables.habitOccurrence.tableArn}/index/byUserEnvironmentDateAndHabitId`,
    ],
  }),
);

platformTables.habit.grantReadWriteData(functions.habit.resources.lambda);
platformTables.habitOccurrence.grantReadWriteData(functions.habit.resources.lambda);
platformTables.habitProgressEvent.grantReadWriteData(functions.habit.resources.lambda);
platformTables.earnedPointAccount.grantReadWriteData(functions.habit.resources.lambda);
platformTables.earnedPointEvent.grantReadWriteData(functions.habit.resources.lambda);
functions.habit.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [
      `${platformTables.habit.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
      `${platformTables.habitOccurrence.tableArn}/index/byUserEnvironmentDateAndHabitId`,
    ],
  }),
);

platformTables.habit.grantReadData(functions.habitEnforcer.resources.lambda);
platformTables.habitOccurrence.grantReadWriteData(functions.habitEnforcer.resources.lambda);
functions.habitEnforcer.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [`${platformTables.habit.tableArn}/index/byEnvironmentStateAndUpdatedAt`],
  }),
);

const habitScheduleStack = backend.createStack('habit-accountability-schedule');
const habitEnforcementRule = new Rule(habitScheduleStack, 'HabitEnforcementRule', {
  schedule: Schedule.rate(Duration.minutes(15)),
  enabled: true,
});
habitEnforcementRule.addTarget(new LambdaFunction(functions.habitEnforcer.resources.lambda));

platformTables.accountDeletionRequest.grantReadWriteData(functions.deletion.resources.lambda);
functions.deletion.addEnvironment(
  'ACCOUNT_DELETION_REQUEST_TABLE_NAME',
  platformTables.accountDeletionRequest.tableName,
);

const deletionDataTables = [
  platformTables.userProfile,
  platformTables.customerLink,
  platformTables.webhook,
  platformTables.subscription,
  platformTables.earnedPointAccount,
  platformTables.earnedPointEvent,
  platformTables.syncedAlarm,
  platformTables.wakeCompletion,
  platformTables.engagementEvent,
  platformTables.habit,
  platformTables.habitOccurrence,
  platformTables.habitProgressEvent,
  platformTables.usernameReservation,
  platformTables.friendRequest,
  platformTables.friendConnection,
  platformTables.accountDeletionRequest,
];
const deletionDataTableArns = deletionDataTables.map((table) => table.tableArn);
const deletionDataIndexArns = [
  `${platformTables.customerLink.tableArn}/index/byCanonicalUser`,
  `${platformTables.webhook.tableArn}/index/byUserAndReceivedAt`,
  `${platformTables.subscription.tableArn}/index/byUserAndEnvironment`,
  `${platformTables.earnedPointAccount.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
  `${platformTables.earnedPointEvent.tableArn}/index/byUserEnvironmentAndCreatedAt`,
  `${platformTables.syncedAlarm.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
  `${platformTables.wakeCompletion.tableArn}/index/byUserEnvironmentAndCompletedAt`,
  `${platformTables.engagementEvent.tableArn}/index/byUserEnvironmentAndReceivedAt`,
  `${platformTables.habit.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
  `${platformTables.habitOccurrence.tableArn}/index/byUserAndCreatedAt`,
  `${platformTables.habitProgressEvent.tableArn}/index/byUserAndCreatedAt`,
  `${platformTables.usernameReservation.tableArn}/index/byUserId`,
  `${platformTables.friendRequest.tableArn}/index/byRequesterEnvironmentAndUpdatedAt`,
  `${platformTables.friendRequest.tableArn}/index/byRecipientEnvironmentAndUpdatedAt`,
  `${platformTables.friendConnection.tableArn}/index/byUserEnvironmentAndCreatedAt`,
  `${platformTables.accountDeletionRequest.tableArn}/index/byStatusAndRequestedAt`,
];
functions.deletionProcessor.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: [
      'dynamodb:BatchWriteItem',
      'dynamodb:DeleteItem',
      'dynamodb:Query',
      'dynamodb:UpdateItem',
    ],
    resources: [...deletionDataTableArns, ...deletionDataIndexArns],
  }),
);

const accountDeletionScheduleStack = backend.createStack('account-deletion-schedule');
const accountDeletionRule = new Rule(accountDeletionScheduleStack, 'AccountDeletionRule', {
  schedule: Schedule.rate(Duration.minutes(5)),
  enabled: true,
});
accountDeletionRule.addTarget(new LambdaFunction(functions.deletionProcessor.resources.lambda));

const webhookStack = backend.createStack('revenuecat-webhook-api');
const webhookApi = new HttpApi(webhookStack, 'RevenueCatWebhookApi', {
  apiName: 'snoozefine-revenuecat-webhook',
  createDefaultStage: false,
});
webhookApi.addRoutes({
  path: '/webhooks/revenuecat',
  methods: [HttpMethod.ANY],
  integration: new HttpLambdaIntegration(
    'RevenueCatWebhookIntegration',
    functions.webhook.resources.lambda,
  ),
});
webhookApi.addStage('DefaultStage', {
  stageName: '$default',
  autoDeploy: true,
  throttle: {
    rateLimit: 10,
    burstLimit: 20,
  },
});

backend.addOutput({
  custom: {
    snoozefine: {
      revenuecat_webhook_url: `${webhookApi.apiEndpoint}/webhooks/revenuecat`,
      environment: process.env.SNOOZEFINE_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
    },
  },
});
