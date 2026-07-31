import type { AppSyncResolverHandler } from 'aws-lambda';
import { cognitoSub, isIanaTimezone } from '../../shared/appsync.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { DomainError } from '../../shared/domain.js';
import { log } from '../../shared/logger.js';
import { linkRevenueCatArgumentsSchema } from '../../shared/validation.js';

type LinkArguments = {
  revenueCatAppUserId: unknown;
  originalAnonymousAppUserId?: unknown;
  timezone: unknown;
};

export const handler: AppSyncResolverHandler<
  LinkArguments,
  { linked: boolean; duplicate: boolean }
> = async (event, context) => {
  const userId = cognitoSub(event.identity);
  const input = linkRevenueCatArgumentsSchema.parse(event.arguments);
  if (!isIanaTimezone(input.timezone)) throw new DomainError('INVALID_TIMEZONE');
  if (input.revenueCatAppUserId !== userId) {
    throw new DomainError('STABLE_REVENUECAT_ID_MUST_MATCH_COGNITO_SUB');
  }
  const repository = new DynamoPlatformRepository(tableNamesFromEnvironment(), 'SANDBOX');
  const result = await repository.linkRevenueCatCustomer({
    userId,
    revenueCatAppUserId: input.revenueCatAppUserId,
    originalAnonymousAppUserId: input.originalAnonymousAppUserId,
    timezone: input.timezone,
    now: new Date().toISOString(),
  });
  log('info', 'revenuecat_customer_linked', {
    correlationId: context.awsRequestId,
    userId,
    duplicate: result.duplicate,
    includedAnonymousAlias: input.originalAnonymousAppUserId !== undefined,
  });
  return result;
};
