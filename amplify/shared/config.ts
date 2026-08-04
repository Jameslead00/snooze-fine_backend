export const PLATFORM_CONFIG = {
  entitlementId: 'snoozefine_plus',
  monthlyProductId: 'snoozefine_plus_monthly',
  habitSettlementLookbackDays: 35,
  wakeCompletionPointEarned: 25,
  habitCompletionPointEarned: 10,
  webhookMaxPayloadBytes: 256 * 1024,
} as const;

export type RevenueCatEnvironment = 'SANDBOX' | 'PRODUCTION';

export function configuredEnvironment(): RevenueCatEnvironment {
  const value = process.env.SNOOZEFINE_ENVIRONMENT ?? 'SANDBOX';
  if (value !== 'SANDBOX' && value !== 'PRODUCTION') {
    throw new Error('SNOOZEFINE_ENVIRONMENT must be SANDBOX or PRODUCTION');
  }
  return value;
}
