import { PLATFORM_CONFIG } from './config.js';
import type { PlatformRepository } from './repository.js';
import type {
  RevenueCatEvent,
  RevenueCatProcessingResult,
  SubscriptionState,
  SubscriptionStatus,
  WebhookRecord,
} from './types.js';

const knownRevenueCatTypes = new Set([
  'INITIAL_PURCHASE',
  'RENEWAL',
  'PRODUCT_CHANGE',
  'CANCELLATION',
  'UNCANCELLATION',
  'EXPIRATION',
  'BILLING_ISSUE',
  'TRANSFER',
  'SUBSCRIPTION_PAUSED',
]);

const unique = (values: Array<string | undefined>): string[] =>
  values
    .filter((value): value is string => value !== undefined)
    .filter((v, i, a) => a.indexOf(v) === i);

function statusForEvent(event: RevenueCatEvent, now: string): SubscriptionStatus {
  switch (event.type) {
    case 'INITIAL_PURCHASE':
    case 'RENEWAL':
    case 'UNCANCELLATION':
    case 'PRODUCT_CHANGE':
      return 'ACTIVE';
    case 'CANCELLATION':
    case 'SUBSCRIPTION_PAUSED':
      return event.expiresAt !== undefined && event.expiresAt > now
        ? 'CANCELLED_PENDING_EXPIRY'
        : 'EXPIRED';
    case 'BILLING_ISSUE':
      return event.gracePeriodExpiresAt !== undefined && event.gracePeriodExpiresAt > now
        ? 'GRACE_PERIOD'
        : 'BILLING_ISSUE';
    case 'EXPIRATION':
      return 'EXPIRED';
    default:
      return 'UNKNOWN';
  }
}

function buildSubscription(
  event: RevenueCatEvent,
  userId: string,
  now: string,
): SubscriptionState | undefined {
  if (
    event.type === 'TRANSFER' ||
    event.appUserId === undefined ||
    event.productId === undefined ||
    event.purchasedAt === undefined ||
    event.expiresAt === undefined ||
    !event.entitlementIds.includes(PLATFORM_CONFIG.entitlementId)
  ) {
    return undefined;
  }
  const status = statusForEvent(event, now);
  return {
    id: `${userId}:${PLATFORM_CONFIG.entitlementId}:${event.environment}`,
    userId,
    revenueCatAppUserId: event.appUserId,
    entitlementId: PLATFORM_CONFIG.entitlementId,
    productId: event.productId,
    status,
    environment: event.environment,
    originalPurchaseAt: event.purchasedAt,
    currentPeriodStart: event.purchasedAt,
    currentPeriodEnd: event.expiresAt,
    autoRenew: event.autoRenew,
    lastRevenueCatEventId: event.id,
    stateEventAt: event.eventAt,
    statusEffectiveAt: status === 'EXPIRED' ? (event.expiresAt ?? event.eventAt) : event.eventAt,
    updatedAt: now,
  };
}

export async function processRevenueCatEvent(
  repository: PlatformRepository,
  event: RevenueCatEvent,
  now = new Date().toISOString(),
): Promise<RevenueCatProcessingResult> {
  const candidateIds =
    event.type === 'TRANSFER'
      ? unique([...event.transferredTo, event.appUserId, event.originalAppUserId, ...event.aliases])
      : unique([
          event.appUserId,
          event.originalAppUserId,
          ...event.aliases,
          ...event.transferredTo,
          ...event.transferredFrom,
        ]);
  const userId = await repository.resolveUserByRevenueCatIds(candidateIds);
  const known = knownRevenueCatTypes.has(event.type);
  const webhook: WebhookRecord = {
    ...event,
    userId,
    status: userId === undefined ? 'UNRESOLVED' : known ? 'PROCESSED' : 'IGNORED',
    error:
      userId === undefined ? 'No linked Cognito user matched RevenueCat identifiers' : undefined,
    receivedAt: now,
    processedAt: now,
  };

  return repository.applyRevenueCatEvent({
    event,
    webhook,
    subscription:
      userId === undefined || !known ? undefined : buildSubscription(event, userId, now),
  });
}

export class DomainError extends Error {
  public constructor(public readonly code: string) {
    super(code);
    this.name = 'DomainError';
  }
}
