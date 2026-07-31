import { defineFunction } from '@aws-amplify/backend';

export const accountApiFunction = defineFunction({
  name: 'snoozefine-account-api',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 15,
  memoryMB: 512,
  environment: {
    SNOOZEFINE_ENVIRONMENT:
      process.env.SNOOZEFINE_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  },
  logging: {
    format: 'json',
    level: 'info',
    retention: '1 month',
  },
});
