import { defineFunction } from '@aws-amplify/backend';

export const habitEnforcerFunction = defineFunction({
  name: 'snoozefine-habit-enforcer',
  entry: './handler.ts',
  runtime: 20,
  timeoutSeconds: 60,
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
