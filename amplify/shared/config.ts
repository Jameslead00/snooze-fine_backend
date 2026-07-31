export const PLATFORM_CONFIG = {
  entitlementId: 'snoozefine_plus',
  monthlyProductId: 'snoozefine_plus_monthly',
  legacySnoozeProductId: 'snooze_1',
  monthlyPointAllocation: 2_000,
  snoozePointDeduction: 25,
  microUsdPerPoint: 1_000,
  settlementMode: 'TEST',
  settlementCalculationVersion: 'v1',
  webhookMaxPayloadBytes: 256 * 1024,
  snoozeFutureToleranceMs: 5 * 60 * 1_000,
  snoozeMaxAgeMs: 7 * 24 * 60 * 60 * 1_000,
} as const;

export type RevenueCatEnvironment = 'SANDBOX' | 'PRODUCTION';

export function configuredEnvironment(): RevenueCatEnvironment {
  const value = process.env.SNOOZEFINE_ENVIRONMENT ?? 'SANDBOX';
  if (value !== 'SANDBOX' && value !== 'PRODUCTION') {
    throw new Error('SNOOZEFINE_ENVIRONMENT must be SANDBOX or PRODUCTION');
  }
  return value;
}
