import { defineFunction } from '@aws-amplify/backend';

export const monthlySettlementFunction = defineFunction({
  name: 'snoozefine-monthly-settlement',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 300,
  memoryMB: 1024,
  schedule: '0 2 1 * ? *',
  environment: {
    SNOOZEFINE_ENVIRONMENT:
      process.env.SNOOZEFINE_ENVIRONMENT === 'PRODUCTION' ? 'PRODUCTION' : 'SANDBOX',
  },
  logging: {
    format: 'json',
    level: 'info',
    retention: '3 months',
  },
});
