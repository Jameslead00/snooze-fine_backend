import { defineFunction } from '@aws-amplify/backend';

export const processAccountDeletionFunction = defineFunction({
  name: 'snoozefine-process-account-deletion',
  entry: './handler.ts',
  resourceGroupName: 'data',
  runtime: 20,
  timeoutSeconds: 900,
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
