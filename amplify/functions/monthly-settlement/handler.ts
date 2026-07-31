import type { AppSyncResolverEvent, EventBridgeEvent } from 'aws-lambda';
import { z } from 'zod';
import { configuredEnvironment, type RevenueCatEnvironment } from '../../shared/config.js';
import {
  DynamoPlatformRepository,
  tableNamesFromEnvironment,
} from '../../shared/dynamo-repository.js';
import { previousUtcMonth, runSettlement } from '../../shared/domain.js';
import { log } from '../../shared/logger.js';

const manualArgumentsSchema = z.object({
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/),
  environment: z.enum(['SANDBOX', 'PRODUCTION']),
  cutoff: z.iso.datetime({ offset: true }),
});

type SettlementInvocation =
  AppSyncResolverEvent<unknown> | EventBridgeEvent<'Scheduled Event', Record<string, never>>;

const isManualInvocation = (event: SettlementInvocation): event is AppSyncResolverEvent<unknown> =>
  'arguments' in event;

export const handler = async (event: SettlementInvocation, context: { awsRequestId: string }) => {
  let month: string;
  let cutoff: string;
  let environment: RevenueCatEnvironment;
  if (isManualInvocation(event)) {
    const input = manualArgumentsSchema.parse(event.arguments);
    month = input.month;
    cutoff = input.cutoff;
    environment = input.environment;
  } else {
    const previous = previousUtcMonth(new Date(event.time));
    month = previous.month;
    cutoff = previous.cutoff;
    environment = configuredEnvironment();
  }

  const repository = new DynamoPlatformRepository(tableNamesFromEnvironment(), environment);
  try {
    const result = await runSettlement(repository, month, environment, cutoff);
    log('info', 'test_settlement_calculated', {
      correlationId: context.awsRequestId,
      month,
      environment,
      duplicate: result.duplicate,
      eligibleUserCount: result.calculation.eligibleUserCount,
      totalRemainingPoints: result.calculation.totalRemainingPoints,
      expectedDonationMicroUsd: result.calculation.expectedDonationMicroUsd,
      actualDonationPaid: false,
    });
    return {
      duplicate: result.duplicate,
      eligibleUserCount: result.calculation.eligibleUserCount,
      totalRemainingPoints: result.calculation.totalRemainingPoints,
      expectedDonationMicroUsd: String(result.calculation.expectedDonationMicroUsd),
      warning: 'TEST SETTLEMENT — EXPECTED DONATION ONLY — NOT YET PAID',
    };
  } catch (error) {
    log('error', 'test_settlement_failed', {
      correlationId: context.awsRequestId,
      month,
      environment,
      errorName: error instanceof Error ? error.name : 'UnknownError',
      actualDonationPaid: false,
    });
    throw new Error('Test settlement calculation failed');
  }
};
