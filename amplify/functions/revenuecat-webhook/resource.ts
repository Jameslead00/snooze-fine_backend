import { defineFunction, secret } from '@aws-amplify/backend';

export const revenueCatWebhook = defineFunction({
  name: 'snoozefine-revenuecat-webhook',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 15,
  memoryMB: 512,
  environment: {
    REVENUECAT_WEBHOOK_AUTH_TOKEN: secret('REVENUECAT_WEBHOOK_AUTH_TOKEN'),
    SNOOZEFINE_ENVIRONMENT:
      process.env.SNOOZEFINE_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  },
  logging: {
    format: 'json',
    level: 'info',
    retention: '1 month',
  },
});
