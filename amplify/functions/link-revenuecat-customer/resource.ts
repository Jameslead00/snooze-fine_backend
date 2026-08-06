import { defineFunction, secret } from '@aws-amplify/backend';

export const linkRevenueCatCustomerFunction = defineFunction({
  name: 'snoozefine-link-revenuecat',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 20,
  memoryMB: 512,
  environment: {
    REVENUECAT_SECRET_API_KEY: secret('REVENUECAT_SECRET_API_KEY'),
  },
  logging: {
    format: 'json',
    level: 'info',
    retention: '1 month',
  },
});
