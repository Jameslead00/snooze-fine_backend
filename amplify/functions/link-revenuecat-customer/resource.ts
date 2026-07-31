import { defineFunction } from '@aws-amplify/backend';

export const linkRevenueCatCustomerFunction = defineFunction({
  name: 'snoozefine-link-revenuecat',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 15,
  memoryMB: 512,
  logging: {
    format: 'json',
    level: 'info',
    retention: '1 month',
  },
});
