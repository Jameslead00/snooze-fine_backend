import type { AppSyncResolverHandler } from 'aws-lambda';
import { cognitoSub } from '../../shared/appsync.js';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { recordSnooze } from '../../shared/domain.js';
import { log } from '../../shared/logger.js';
import { recordSnoozeArgumentsSchema } from '../../shared/validation.js';

interface RecordSnoozeArguments {
  input: unknown;
}

export const handler: AppSyncResolverHandler<
  RecordSnoozeArguments,
  Awaited<ReturnType<typeof recordSnooze>>
> = async (event, context) => {
  const userId = cognitoSub(event.identity);
  const input = recordSnoozeArgumentsSchema.parse(event.arguments.input);
  const repository = new DynamoPlatformRepository(
    tableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const result = await recordSnooze(repository, { userId, ...input });
  log('info', 'snooze_recorded', {
    correlationId: context.awsRequestId,
    userId,
    snoozeEventId: input.snoozeEventId,
    duplicate: result.duplicate,
    pointsDeducted: result.pointsDeducted,
  });
  return result;
};
