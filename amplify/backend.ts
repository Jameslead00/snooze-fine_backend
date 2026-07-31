import { defineBackend } from '@aws-amplify/backend';
import { HttpApi, HttpMethod } from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import type { ITable } from 'aws-cdk-lib/aws-dynamodb';
import { auth } from './auth/resource.js';
import { data } from './data/resource.js';
import { accountApiFunction } from './functions/account-api/resource.js';
import { linkRevenueCatCustomerFunction } from './functions/link-revenuecat-customer/resource.js';
import { monthlySettlementFunction } from './functions/monthly-settlement/resource.js';
import { recordSnoozeFunction } from './functions/record-snooze/resource.js';
import { revenueCatWebhook } from './functions/revenuecat-webhook/resource.js';

const backend = defineBackend({
  auth,
  data,
  accountApiFunction,
  linkRevenueCatCustomerFunction,
  monthlySettlementFunction,
  recordSnoozeFunction,
  revenueCatWebhook,
});

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
  settlement: requireTable('MonthlySettlement'),
};
const functions = {
  account: backend.accountApiFunction,
  link: backend.linkRevenueCatCustomerFunction,
  settlement: backend.monthlySettlementFunction,
  snooze: backend.recordSnoozeFunction,
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
  ['MONTHLY_SETTLEMENT_TABLE_NAME', platformTables.settlement],
];

for (const target of Object.values(functions)) {
  for (const [variableName, table] of allTableEnvironment) {
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

platformTables.subscription.grantReadData(functions.settlement.resources.lambda);
platformTables.period.grantReadData(functions.settlement.resources.lambda);
platformTables.settlement.grantReadWriteData(functions.settlement.resources.lambda);

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
      admin_tables: Object.fromEntries(
        allTableEnvironment.map(([variableName, table]) => [variableName, table.tableName]),
      ),
    },
  },
});
