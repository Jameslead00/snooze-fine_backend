import { defineBackend } from '@aws-amplify/backend';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { Duration } from 'aws-cdk-lib';
import { Rule, Schedule } from 'aws-cdk-lib/aws-events';
import { LambdaFunction } from 'aws-cdk-lib/aws-events-targets';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { accountApiFunction } from './functions/account-api/resource.js';
import { habitApiFunction } from './functions/habit-api/resource.js';
import { habitEnforcerFunction } from './functions/habit-enforcer/resource.js';
import { linkRevenueCatCustomerFunction } from './functions/link-revenuecat-customer/resource.js';
import { monthlySettlementFunction } from './functions/monthly-settlement/resource.js';
import { recordSnoozeFunction } from './functions/record-snooze/resource.js';
import { requestAccountDeletionFunction } from './functions/request-account-deletion/resource.js';
import { revenueCatWebhook } from './functions/revenuecat-webhook/resource.js';

const backend = defineBackend({
  auth,
  data,
  accountApiFunction,
  habitApiFunction,
  habitEnforcerFunction,
  linkRevenueCatCustomerFunction,
  monthlySettlementFunction,
  recordSnoozeFunction,
  requestAccountDeletionFunction,
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
  period: requireTable('PointPeriod'),
  account: requireTable('PointAccount'),
  transaction: requireTable('PointTransaction'),
  snooze: requireTable('SnoozeEvent'),
  syncedAlarm: requireTable('SyncedAlarm'),
  wakeCompletion: requireTable('WakeCompletion'),
  engagementEvent: requireTable('EngagementEvent'),
  settlement: requireTable('MonthlySettlement'),
  habit: requireTable('HabitDefinition'),
  habitOccurrence: requireTable('HabitOccurrence'),
  habitProgressEvent: requireTable('HabitProgressEvent'),
  charity: requireTable('Charity'),
  communityBallot: requireTable('CommunityBallot'),
  dailyCharityVote: requireTable('DailyCharityVote'),
  donationRecord: requireTable('DonationRecord'),
  accountDeletionRequest: requireTable('AccountDeletionRequest'),
};
const functions = {
  account: backend.accountApiFunction,
  habit: backend.habitApiFunction,
  habitEnforcer: backend.habitEnforcerFunction,
  link: backend.linkRevenueCatCustomerFunction,
  settlement: backend.monthlySettlementFunction,
  snooze: backend.recordSnoozeFunction,
  deletion: backend.requestAccountDeletionFunction,
  webhook: backend.revenueCatWebhook,
};

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
  ['POINT_PERIOD_TABLE_NAME', platformTables.period],
  ['POINT_ACCOUNT_TABLE_NAME', platformTables.account],
  ['POINT_TRANSACTION_TABLE_NAME', platformTables.transaction],
  ['SNOOZE_EVENT_TABLE_NAME', platformTables.snooze],
  ['SYNCED_ALARM_TABLE_NAME', platformTables.syncedAlarm],
  ['WAKE_COMPLETION_TABLE_NAME', platformTables.wakeCompletion],
  ['ENGAGEMENT_EVENT_TABLE_NAME', platformTables.engagementEvent],
  ['MONTHLY_SETTLEMENT_TABLE_NAME', platformTables.settlement],
  ['CHARITY_TABLE_NAME', platformTables.charity],
  ['COMMUNITY_BALLOT_TABLE_NAME', platformTables.communityBallot],
  ['DAILY_CHARITY_VOTE_TABLE_NAME', platformTables.dailyCharityVote],
  ['DONATION_RECORD_TABLE_NAME', platformTables.donationRecord],
];

for (const target of Object.values(functions)) {
  for (const [variableName, table] of allTableEnvironment) {
    addTableEnvironment(target, variableName, table.tableName);
  }
}

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

platformTables.customerLink.grantReadData(functions.webhook.resources.lambda);
platformTables.webhook.grantReadWriteData(functions.webhook.resources.lambda);
platformTables.subscription.grantReadWriteData(functions.webhook.resources.lambda);
platformTables.period.grantReadWriteData(functions.webhook.resources.lambda);
platformTables.account.grantReadWriteData(functions.webhook.resources.lambda);
platformTables.transaction.grantReadWriteData(functions.webhook.resources.lambda);

platformTables.subscription.grantReadData(functions.snooze.resources.lambda);
platformTables.account.grantReadWriteData(functions.snooze.resources.lambda);
platformTables.period.grantReadWriteData(functions.snooze.resources.lambda);
platformTables.transaction.grantReadWriteData(functions.snooze.resources.lambda);
platformTables.snooze.grantReadWriteData(functions.snooze.resources.lambda);

platformTables.userProfile.grantReadWriteData(functions.link.resources.lambda);
platformTables.customerLink.grantReadWriteData(functions.link.resources.lambda);

platformTables.subscription.grantReadData(functions.account.resources.lambda);
platformTables.account.grantReadData(functions.account.resources.lambda);
platformTables.period.grantReadData(functions.account.resources.lambda);
platformTables.transaction.grantReadData(functions.account.resources.lambda);
platformTables.userProfile.grantReadData(functions.account.resources.lambda);
platformTables.snooze.grantReadData(functions.account.resources.lambda);
platformTables.syncedAlarm.grantReadWriteData(functions.account.resources.lambda);
platformTables.wakeCompletion.grantReadWriteData(functions.account.resources.lambda);
platformTables.engagementEvent.grantReadWriteData(functions.account.resources.lambda);
platformTables.charity.grantReadData(functions.account.resources.lambda);
platformTables.communityBallot.grantReadWriteData(functions.account.resources.lambda);
platformTables.dailyCharityVote.grantReadWriteData(functions.account.resources.lambda);
platformTables.donationRecord.grantReadData(functions.account.resources.lambda);
platformTables.habit.grantReadData(functions.account.resources.lambda);
platformTables.habitOccurrence.grantReadData(functions.account.resources.lambda);
functions.account.resources.lambda.addToRolePolicy(
  new PolicyStatement({
    actions: ['dynamodb:Query'],
    resources: [
      `${platformTables.transaction.tableArn}/index/byUserEnvironmentAndCreatedAt`,
      `${platformTables.snooze.tableArn}/index/byUserAndReceivedAt`,
      `${platformTables.syncedAlarm.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
      `${platformTables.wakeCompletion.tableArn}/index/byUserEnvironmentAndCompletedAt`,
      `${platformTables.communityBallot.tableArn}/index/byEnvironmentStatusAndClosesAt`,
      `${platformTables.period.tableArn}/index/byEnvironmentAndPeriodEnd`,
      `${platformTables.habit.tableArn}/index/byUserEnvironmentAndUpdatedAt`,
      `${platformTables.habitOccurrence.tableArn}/index/byUserEnvironmentDateAndHabitId`,
    ],
  }),
);

platformTables.habit.grantReadWriteData(functions.habit.resources.lambda);
platformTables.habitOccurrence.grantReadWriteData(functions.habit.resources.lambda);
platformTables.habitProgressEvent.grantReadWriteData(functions.habit.resources.lambda);
platformTables.account.grantReadData(functions.habit.resources.lambda);
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
platformTables.subscription.grantReadData(functions.habitEnforcer.resources.lambda);
platformTables.account.grantReadWriteData(functions.habitEnforcer.resources.lambda);
platformTables.period.grantReadWriteData(functions.habitEnforcer.resources.lambda);
platformTables.transaction.grantReadWriteData(functions.habitEnforcer.resources.lambda);
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

platformTables.subscription.grantReadData(functions.settlement.resources.lambda);
platformTables.period.grantReadData(functions.settlement.resources.lambda);
platformTables.settlement.grantReadWriteData(functions.settlement.resources.lambda);

platformTables.accountDeletionRequest.grantWriteData(functions.deletion.resources.lambda);
functions.deletion.addEnvironment(
  'ACCOUNT_DELETION_REQUEST_TABLE_NAME',
  platformTables.accountDeletionRequest.tableName,
);

const webhookStack = backend.createStack('revenuecat-webhook-api');
const webhookApi = new HttpApi(webhookStack, 'RevenueCatWebhookApi', {
  apiName: 'snoozefine-revenuecat-webhook',
  createDefaultStage: true,
});
webhookApi.addRoutes({
  path: '/webhooks/revenuecat',
  methods: [HttpMethod.ANY],
  integration: new HttpLambdaIntegration(
    'RevenueCatWebhookIntegration',
    functions.webhook.resources.lambda,
  ),
});

backend.addOutput({
  custom: {
    snoozefine: {
      revenuecat_webhook_url: `${webhookApi.apiEndpoint}/webhooks/revenuecat`,
      environment: process.env.SNOOZEFINE_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
      settlement_mode: 'TEST',
    },
  },
});
