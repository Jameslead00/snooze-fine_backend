import type { AppSyncResolverHandler } from 'aws-lambda';
import { cognitoSub, isIanaTimezone } from '../../shared/appsync.js';
import { configuredEnvironment } from '../../shared/config.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { DomainError } from '../../shared/domain.js';
import { log } from '../../shared/logger.js';
import { DynamoRateLimiter, rateLimitPolicyFor } from '../../shared/rate-limit.js';
import {
  fetchRevenueCatCustomerInfo,
  subscriptionFromRevenueCatCustomerInfo,
} from '../../shared/revenuecat-reconciliation.js';
import { linkRevenueCatArgumentsSchema } from '../../shared/validation.js';

type LinkArguments = {
  revenueCatAppUserId: unknown;
  originalAnonymousAppUserId?: unknown;
  timezone: unknown;
  creatorCode?: unknown;
};

export const handler: AppSyncResolverHandler<
  LinkArguments,
  { linked: boolean; duplicate: boolean }
> = async (event, context) => {
  const userId = cognitoSub(event.identity);
  const rateLimitPolicy = rateLimitPolicyFor('linkRevenueCatCustomer');
  if (rateLimitPolicy === undefined) throw new Error('LINK_RATE_LIMIT_POLICY_NOT_CONFIGURED');
  await new DynamoRateLimiter().check(userId, rateLimitPolicy);
  const input = linkRevenueCatArgumentsSchema.parse(event.arguments);
  if (!isIanaTimezone(input.timezone)) throw new DomainError('INVALID_TIMEZONE');
  if (input.revenueCatAppUserId !== userId) {
    throw new DomainError('STABLE_REVENUECAT_ID_MUST_MATCH_COGNITO_SUB');
  }
  const repository = new DynamoPlatformRepository(
    tableNamesFromEnvironment(),
    configuredEnvironment(),
  );
  const result = await repository.linkRevenueCatCustomer({
    userId,
    revenueCatAppUserId: input.revenueCatAppUserId,
    originalAnonymousAppUserId: input.originalAnonymousAppUserId,
    timezone: input.timezone,
    creatorCode: input.creatorCode,
    now: new Date().toISOString(),
  });
  const now = new Date().toISOString();
  let reconciled = false;
  try {
    const customerInfo = await fetchRevenueCatCustomerInfo(input.revenueCatAppUserId);
    const subscription =
      customerInfo === undefined
        ? undefined
        : subscriptionFromRevenueCatCustomerInfo(customerInfo, userId, input.revenueCatAppUserId, now);
    if (subscription !== undefined) {
      await repository.reconcileRevenueCatSubscription({ subscription, now });
      reconciled = true;
    }
  } catch (error) {
    // Linking is still useful when RevenueCat is temporarily unavailable. The
    // next client retry will perform the lookup again, while the failure is
    // visible in CloudWatch without leaking the API key or customer payload.
    log('warn', 'revenuecat_customer_reconciliation_failed', {
      correlationId: context.awsRequestId,
      userId,
      error: error instanceof Error ? error.message : 'unknown_error',
    });
  }
  log('info', 'revenuecat_customer_linked', {
    correlationId: context.awsRequestId,
    userId,
    duplicate: result.duplicate,
    includedAnonymousAlias: input.originalAnonymousAppUserId !== undefined,
    reconciled,
  });
  return result;
};
