import { sha256 } from '../amplify/shared/security.js';
import type { RevenueCatEvent } from '../amplify/shared/types.js';

export function revenueCatEvent(overrides: Partial<RevenueCatEvent> = {}): RevenueCatEvent {
  const base: RevenueCatEvent = {
    id: 'rc-event-1',
    type: 'INITIAL_PURCHASE',
    appUserId: 'user-1',
    originalAppUserId: 'anonymous-1',
    aliases: [],
    transferredFrom: [],
    transferredTo: [],
    productId: 'snoozefine_plus_monthly',
    entitlementIds: ['snoozefine_plus'],
    eventAt: '2026-07-01T00:00:01.000Z',
    purchasedAt: '2026-07-01T00:00:00.000Z',
    expiresAt: '2026-08-01T00:00:00.000Z',
    gracePeriodExpiresAt: undefined,
    environment: 'SANDBOX',
    autoRenew: true,
    payloadHash: sha256('fixture'),
    rawMetadata: '{}',
  };
  return { ...base, ...overrides };
}
